import { useEffect, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import type { AgentSummary, AuthInfo } from '../api/types';
import { AuthRequiredError } from '../api/errors';
import { Wordmark } from '../components/Brand';
import { PrimaryButton } from '../components/ui';
import { ChatView } from '../chat/ChatView';
import { resetChats } from '../chat/store';
import { Manage } from '../agents/Manage';
import { setTheme } from '../state';
import { navigate, useRoute } from '../router';
import { t } from '../i18n/t';

/** The signed-in frame: agent list + chat on desktop (sidebar), drawer on phones. */
export function Shell({ client, info, onSignedOut }: { client: Client; info: AuthInfo; onSignedOut: () => void }) {
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owner = info.user?.role === 'owner';
  const lost = () => { resetChats(); onSignedOut(); };
  const load = () => { setError(null); client.agents().then(setAgents).catch((e) => { if (e instanceof AuthRequiredError) lost(); else setError(t('home.failed')); }); };
  useEffect(load, []);
  useEffect(() => { const id = setInterval(() => client.agents().then(setAgents).catch(() => {}), 30000); return () => clearInterval(id); }, []);
  async function signOut() { try { await client.logout(); } catch { /* the cookie may already be gone */ } lost(); }
  const selected = route.name !== 'manage' ? agents?.find((a) => a.name === route.params.get('agent')) ?? agents?.[0] : undefined;
  const go = () => setOpen(false);
  return (
    <div class={`shell${open ? ' drawer-open' : ''}`}>
      <header class="topbar"><button class="icon-btn" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(!open)}>☰</button><Wordmark height={28} /></header>
      <aside class="sidebar" aria-label="Navigation">
        <Wordmark height={34} />
        <nav aria-label={t('nav.recent')}>
          <span class="nav-label">{t('nav.recent')}</span>
          {agents?.map((a) => (
            <a key={a.name} href={`#/chat?agent=${encodeURIComponent(a.name)}`} class={selected?.name === a.name ? 'active' : ''} onClick={go}>
              <span class={`dot ${a.online ? 'on' : 'off'}`} aria-label={a.online ? t('chat.online') : t('chat.offline')} /><span class="grow">{a.displayName || a.name}</span>
            </a>
          ))}
          {owner && <a href="#/manage" class={route.name === 'manage' ? 'active' : ''} onClick={go}>{t('nav.manage')}</a>}
        </nav>
        <div class="sidebar-foot">
          <span class="muted small">{info.user?.username}{owner ? ' · Owner' : ''}</span>
          <div class="row">
            <button class="btn text" onClick={() => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')}>Theme</button>
            <button class="btn text" onClick={signOut}>{t('nav.signOut')}</button>
          </div>
        </div>
      </aside>
      <div class="scrim" onClick={go} />
      <main class="content">
        {error && <div class="card"><p class="error">{error}</p><PrimaryButton type="button" onClick={load}>{t('home.retry')}</PrimaryButton></div>}
        {!error && agents === null && <p class="muted pad">{t('home.loading')}</p>}
        {route.name === 'manage' && owner && <Manage client={client} onChanged={load} onAuthLost={lost} />}
        {route.name !== 'manage' && agents && agents.length === 0 && (
          <div class="empty-home"><p class="muted">{t('home.empty')}</p>{owner && <button class="btn primary inline" onClick={() => navigate('manage')}>{t('home.addFirst')}</button>}</div>
        )}
        {route.name !== 'manage' && selected && <ChatView key={selected.name} client={client} agent={selected} onAuthLost={lost} />}
      </main>
    </div>
  );
}
