import { useEffect, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import type { AgentSummary, AuthInfo } from '../api/types';
import { AuthRequiredError } from '../api/errors';
import { Wordmark } from '../components/Brand';
import { PrimaryButton } from '../components/ui';
import { setTheme } from '../state';
import { navigate, useRoute } from '../router';
import { t } from '../i18n/t';

/** The signed-in frame: desktop sidebar, phone drawer. Screens are added route by route (agents first). */
export function Shell({ client, info, onSignedOut }: { client: Client; info: AuthInfo; onSignedOut: () => void }) {
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => { setError(null); setAgents(null); client.agents().then(setAgents).catch((e) => { if (e instanceof AuthRequiredError) onSignedOut(); else setError(t('home.failed')); }); };
  useEffect(load, []);
  async function signOut() { try { await client.logout(); } catch { /* the cookie may already be gone */ } onSignedOut(); }
  return (
    <div class={`shell${open ? ' drawer-open' : ''}`}>
      <header class="topbar"><button class="icon-btn" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(!open)}>☰</button><Wordmark height={28} /></header>
      <aside class="sidebar" aria-label="Navigation">
        <Wordmark height={34} />
        <nav>
          <a href="#/agents" class={route.name === 'agents' ? 'active' : ''} onClick={() => setOpen(false)}>{t('nav.agents')}</a>
        </nav>
        <div class="sidebar-foot">
          <span class="muted small">{info.user?.username}{info.user?.role === 'owner' ? ' · Owner' : ''}</span>
          <div class="row">
            <button class="btn text" onClick={() => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')}>Theme</button>
            <button class="btn text" onClick={signOut}>{t('nav.signOut')}</button>
          </div>
        </div>
      </aside>
      <div class="scrim" onClick={() => setOpen(false)} />
      <main class="content">
        <h1>{t('home.title')}</h1>
        {error && <div class="card"><p class="error">{error}</p><PrimaryButton type="button" onClick={load}>{t('home.retry')}</PrimaryButton></div>}
        {!error && agents === null && <p class="muted">{t('home.loading')}</p>}
        {agents && agents.length === 0 && <div class="card"><p class="muted">{t('home.empty')}</p></div>}
        {agents && agents.length > 0 && (
          <ul class="card list">
            {agents.map((a) => (
              <li key={a.id ?? a.name} onClick={() => navigate('agents', { agent: a.name })}>
                <span class={`dot ${a.online ? 'on' : 'off'}`} aria-label={a.online ? 'online' : 'offline'} />
                <span class="grow"><b>{a.displayName || a.name}</b><small class="muted">{a.description || a.kind}</small></span>
                <span class="pill">{a.online ? 'Online' : 'Offline'}</span>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
