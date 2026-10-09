import { useEffect, useState } from 'preact/hooks';
import type { Client, SendMode } from '../api/client';
import { ApiError } from '../api/errors';
import { t } from '../i18n/t';
type K = Parameters<typeof t>[0];

/** Agent settings, not chat: the Hermes profile default for messages sent while it works. It affects every chat of the profile, so it asks first. */
export function ProfileBusy({ client, agent }: { client: Client; agent: string }) {
  const [mode, setMode] = useState<string | null>(null), [err, setErr] = useState('');
  useEffect(() => { let on = true; void client.profileBusy(agent).then((m) => on && setMode(m || '')).catch(() => on && setMode(null)); return () => { on = false; }; }, [agent]);
  if (mode === null) return null; // not a native Hermes agent: nothing to set here
  async function change(m: SendMode) {
    if (!confirm(t('ctl.busyConfirm'))) return;
    try { await client.setProfileBusy(agent, m); setMode(m); setErr(''); } catch (e) { setErr(t('ctl.busyFailed', { error: e instanceof ApiError ? e.message : t('error.generic') })); }
  }
  const label = (m: string) => t(('busy.' + m) as K);
  return (
    <div class="card stack" aria-label={t('ctl.busyTitle')}>
      <h3>{t('ctl.busyTitle')}</h3>
      <p class="warn" role="note">{t('ctl.busyWarn')}</p>
      {mode && <p>{t('ctl.busyNow', { mode: label(mode) })}</p>}
      <div class="row">{(['queue', 'steer', 'interrupt'] as SendMode[]).map((m) => <button key={m} type="button" class="btn text" disabled={mode === m} onClick={() => void change(m)}>{label(m)}</button>)}</div>
      {err && <p class="error" role="alert">{err}</p>}
    </div>
  );
}
