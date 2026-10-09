import { useEffect, useRef, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import type { AgentSummary } from '../api/types';
import { Composer } from './Composer';
import { draftKey } from './drafts';
import { SessionsMenu } from './SessionsMenu';
import { Markdown, Message } from './Message';
import { MediaViewer, type MediaItem } from '../components/MediaViewer';
import { chatOf, loadAgent, newChat, openSession, send, stop, useChat } from './store';
import type { LocalCommand } from '../lib/commands';
import { navigate } from '../router';
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
  const last = c.messages[c.messages.length - 1];
  // Screen readers get one announcement when a reply starts and one when it ends, never a token-by-token flood.
  const announce = c.streaming ? t('a11y.replying', { agent: agent.displayName || agent.name }) : last?.role === 'assistant' ? t('a11y.replied', { agent: agent.displayName || agent.name, text: last.content.replace(/\s+/g, ' ').slice(0, 300) }) : '';
  const status = c.streaming ? statusLine(agent.displayName || agent.name, c.tool, c.streamText.length > 0, c.streamReasoning.length > 0) : null;
  const name = agent.displayName || agent.name;
  return (
    <section class="chat" aria-label={name}>
      <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{announce}</div>
      <header class="chat-head">
        <span class={`dot ${agent.online ? 'on' : 'off'}`} aria-hidden="true" />
        <div class="grow"><b>{name}</b><small class="muted">{status ?? (agent.online ? t('chat.online') : t('chat.offline'))}</small></div>
        {agent.capabilities?.screen && agent.online && <button class="btn text" onClick={() => navigate('screen', { agent: agent.name })}>{t('chat.screen')}</button>}
        <button class="btn text" onClick={() => newChat(agent.name)}>{t('chat.new')}</button>
        {agent.capabilities?.sessions !== false && <SessionsMenu sessions={c.sessions} current={c.session} open={sessionsOpen} onOpenChange={setSessionsOpen}
          onSelect={(id) => { void openSession(client, agent.name, id, onAuthLost); }} />}
      </header>
      <div class="messages" ref={scroller} onLoadCapture={() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }} onScroll={(e) => { const el = e.currentTarget as HTMLElement; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} role="log" aria-label={t('chat.message')} aria-live="off" tabIndex={0}>
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
      <Composer key={draftKey(agent.name, c.session)} client={client} agent={agent} history={c.messages} streaming={c.streaming} skills={c.skills} draftKey={draftKey(agent.name, c.session)}
        onSend={(text, imgs, files) => void send(client, agent.name, text, imgs, files, onAuthLost)} onStop={() => stop(agent.name)} onLocal={local} />
      {viewer && <MediaViewer item={viewer} onClose={() => setViewer(null)} />}
    </section>
  );
}
export { chatOf };
