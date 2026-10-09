import { useEffect, useRef, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import type { AgentSummary, AuthInfo } from '../api/types';
import { AuthRequiredError } from '../api/errors';
import { Wordmark } from '../components/Brand';
import { PrimaryButton } from '../components/ui';
import { ChatView } from '../chat/ChatView';
import { resetChats } from '../chat/store';
import { setDraftScope, wipeDrafts } from '../chat/drafts';
import { Manage } from '../agents/Manage';
import { Admin } from '../admin/Admin';
import { Account } from '../admin/Account';
import { Settings } from '../admin/Settings';
import { ScreenView } from '../screen/ScreenView';
import { loadHub, setTheme } from '../state';
import { navigate, useRoute } from '../router';
import { forgetAll, lastAgent } from '../lib/persist';
import { t } from '../i18n/t';

/** The signed-in frame: agent list + chat on desktop (sidebar), drawer on phones. */
export function Shell({ client, info, onSignedOut }: { client: Client; info: AuthInfo; onSignedOut: () => void }) {
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owner = info.user?.role === 'owner';
  setDraftScope(info.user?.id); // unsent text is stored per signed-in user (set before the chat reads its draft)
  const main = useRef<HTMLElement>(null);
  useEffect(() => { const el = main.current; if (el && route.name !== 'agents') el.focus({ preventScroll: true }); }, [route.name]); // keep keyboard focus in the new view
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [open]);
  const lost = () => { resetChats(); onSignedOut(); };
  const load = () => { setError(null); client.agents().then(setAgents).catch((e) => { if (e instanceof AuthRequiredError) lost(); else setError(t('home.failed')); }); };
  useEffect(load, []);
  useEffect(() => { const id = setInterval(() => client.agents().then(setAgents).catch(() => {}), 30000); return () => clearInterval(id); }, []);
  async function signOut() { try { await client.logout(); } catch { /* the cookie may already be gone */ } forgetAll(); wipeDrafts(); lost(); }
  const PAGES = ['manage', 'admin', 'account', 'settings'];
  const selected = !PAGES.includes(route.name) ? agents?.find((a) => a.name === (route.params.get('agent') ?? lastAgent())) ?? agents?.[0] : undefined;
  const go = () => setOpen(false);
  return (
    <div class={`shell${open ? ' drawer-open' : ''}`}>
      <a class="skip" href="#main" onClick={(e) => { e.preventDefault(); main.current?.focus(); }}>{t('a11y.skip')}</a>
      <header class="topbar"><button class="icon-btn" aria-label={t('nav.menu')} aria-expanded={open} aria-controls="sidebar" onClick={() => setOpen(!open)}>☰</button><Wordmark height={28} /></header>
      <aside class="sidebar" id="sidebar" aria-label="Navigation">
        <Wordmark height={34} />
        <nav aria-label={t('nav.recent')}>
          <span class="nav-label">{t('nav.recent')}</span>
          {agents?.map((a) => (
            <a key={a.name} href={`#/chat?agent=${encodeURIComponent(a.name)}`} class={selected?.name === a.name ? 'active' : ''} aria-current={selected?.name === a.name ? 'page' : undefined} onClick={go}>
              <span class={`dot ${a.online ? 'on' : 'off'}`} aria-label={a.online ? t('chat.online') : t('chat.offline')} /><span class="grow">{a.displayName || a.name}</span>
            </a>
          ))}
        </nav>
        <nav aria-label="Account and tools" class="tools">
          {owner && <a href="#/manage" class={route.name === 'manage' ? 'active' : ''} aria-current={route.name === 'manage' ? 'page' : undefined} onClick={go}>{t('nav.manage')}</a>}
          {owner && <a href="#/admin" class={route.name === 'admin' ? 'active' : ''} aria-current={route.name === 'admin' ? 'page' : undefined} onClick={go}>{t('nav.admin')}</a>}
          <a href="#/account" class={route.name === 'account' ? 'active' : ''} aria-current={route.name === 'account' ? 'page' : undefined} onClick={go}>{t('nav.account')}</a>
          <a href="#/settings" class={route.name === 'settings' ? 'active' : ''} aria-current={route.name === 'settings' ? 'page' : undefined} onClick={go}>{t('nav.settings')}</a>
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
      <main class="content" id="main" tabIndex={-1} ref={main}>
        {error && <div class="card"><p class="error">{error}</p><PrimaryButton type="button" onClick={load}>{t('home.retry')}</PrimaryButton></div>}
        {!error && agents === null && <p class="muted pad">{t('home.loading')}</p>}
        {route.name === 'manage' && owner && <Manage client={client} onChanged={load} onAuthLost={lost} />}
        {route.name === 'admin' && owner && <Admin client={client} onAuthLost={lost} />}
        {route.name === 'account' && <Account client={client} onAuthLost={lost} />}
        {route.name === 'settings' && <Settings hub={loadHub()} />}
        {!PAGES.includes(route.name) && agents && agents.length === 0 && (
          <div class="empty-home"><p class="muted">{t('home.empty')}</p>{owner && <button class="btn primary inline" onClick={() => navigate('manage')}>{t('home.addFirst')}</button>}</div>
        )}
        {route.name === 'screen' && selected && <ScreenView key={selected.name} client={client} agent={selected} onAuthLost={lost} onClose={() => navigate('chat', { agent: selected.name })} />}
        {route.name !== 'screen' && !PAGES.includes(route.name) && selected && <ChatView key={selected.name} client={client} agent={selected} onAuthLost={lost} session={route.params.get('session') ?? undefined} />}
      </main>
    </div>
  );
}
