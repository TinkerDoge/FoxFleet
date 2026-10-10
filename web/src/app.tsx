import { useEffect, useState } from 'preact/hooks';
import { createClient } from './api/client';
import type { AuthInfo } from './api/types';
import { ApiError, NetworkError } from './api/errors';
import { backoff, isTransientStatus } from './api/client';
import { AuthScreen } from './screens/AuthScreen';
import { HubAddressScreen } from './screens/HubAddressScreen';
import { Shell } from './screens/Shell';
import { displayHub, loadHub, makeClient, saveHub } from './state';
import { parseLink } from './lib/hubAddress';
import { t } from './i18n/t';

type Phase = { name: 'boot' } | { name: 'hub'; initial?: string } | { name: 'auth'; info: AuthInfo } | { name: 'home'; info: AuthInfo };

/** A ?hub=...&invite=... query (from a shared link) pre-fills the address screen and the join form. */
function incoming() { const l = parseLink(location.search); return l ?? null; }

export function App() {
  const [hub, setHub] = useState(loadHub());
  const [phase, setPhase] = useState<Phase>({ name: 'boot' });
  const [invite] = useState(() => incoming()?.invite ?? '');
  const client = makeClient(hub);
  const [waiting, setWaiting] = useState(false);
  async function boot(base = hub) {
    setPhase({ name: 'boot' });
    // A tunnel blip (502/503/504, timeout) while opening the app is not "no hub here" and never a sign-out: keep trying quietly.
    for (let n = 0; ; n++) {
      try {
        const info = await createClient({ base }).authInfo();
        setWaiting(false); setPhase(info.authenticated ? { name: 'home', info } : { name: 'auth', info }); return;
      } catch (e) {
        const transient = base !== '' && (e instanceof NetworkError || (e instanceof ApiError && isTransientStatus(e.status)));
        if (!transient || n >= 7) { setWaiting(false); break; }
        setWaiting(true); await new Promise((r) => setTimeout(r, backoff(n, 700, 8000)));
      }
    }
    try {
      const info = await createClient({ base }).authInfo();
      setPhase(info.authenticated ? { name: 'home', info } : { name: 'auth', info });
    } catch (e) {
      // No hub on this origin (static host or dev server): ask for one. Any other failure also lands here with the address pre-filled.
      setPhase({ name: 'hub', initial: base || incoming()?.hub || '' });
      if (!(e instanceof NetworkError || e instanceof ApiError)) throw e;
    }
  }
  useEffect(() => { void boot(); }, []);
  const connected = (url: string) => { saveHub(url); setHub(url); void boot(url); };
  const changeHub = () => { saveHub(''); setHub(''); setPhase({ name: 'hub', initial: '' }); };
  switch (phase.name) {
    case 'boot': return <div class="boot" role="status">{waiting ? t('boot.reconnecting') : t('boot.opening')}</div>;
    case 'hub': return <HubAddressScreen initial={phase.initial} onConnected={connected} />;
    case 'auth': return <AuthScreen client={client} info={phase.info} hubLabel={displayHub(hub)} invite={invite} onDone={() => void boot()} onChangeHub={hub ? changeHub : undefined} />;
    case 'home': return <Shell client={client} info={phase.info} onSignedOut={() => void boot()} />;
  }
}
