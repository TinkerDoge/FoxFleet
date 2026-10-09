import { useState } from 'preact/hooks';
import { Wordmark } from '../components/Brand';
import { ErrorLine, Field, PrimaryButton, TextButton } from '../components/ui';
import { normalizeHub, PLACEHOLDER } from '../lib/hubAddress';
import { createClient } from '../api/client';
import { ApiError, NetworkError } from '../api/errors';
import { t } from '../i18n/t';

/** First launch when no hub answers on this origin: type (or open a link with) the hub address; it is validated before it's saved. */
export function HubAddressScreen({ initial = '', onConnected, onCancel }: { initial?: string; onConnected: (url: string) => void; onCancel?: () => void }) {
  const [text, setText] = useState(initial);
  const [allowHttp, setAllowHttp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: Event) {
    e.preventDefault();
    const n = normalizeHub(text, allowHttp);
    if (!n.url) { setError(n.error!); return; }
    setBusy(true); setError(null);
    try { await createClient({ base: n.url }).authInfo(); onConnected(n.url); }
    catch (err) { setError(err instanceof ApiError ? t('hub.notHub') : err instanceof NetworkError ? t('hub.unreachable') : t('error.generic')); }
    finally { setBusy(false); }
  }
  return (
    <main class="center-screen">
      <form class="stack" onSubmit={submit}>
        <Wordmark />
        <h1>{t('hub.title')}</h1>
        <p class="muted">{t('hub.body')}</p>
        <Field label={t('hub.address')} name="hub" value={text} onInput={(v) => { setText(v); setError(null); }} autoFocus />
        <ErrorLine message={error} />
        <label class="check"><input type="checkbox" checked={allowHttp} onChange={(e) => setAllowHttp((e.currentTarget as HTMLInputElement).checked)} /><span><b>{t('hub.allowHttp')}</b><small>{t('hub.allowHttpHint')}</small></span></label>
        <PrimaryButton busy={busy} disabled={!text.trim()}>{busy ? t('hub.checking') : t('hub.continue')}</PrimaryButton>
        <p class="muted small">{t('hub.scanHint')}</p>
        <p class="muted small">e.g. {PLACEHOLDER}</p>
        {onCancel && <TextButton onClick={onCancel}>Cancel</TextButton>}
      </form>
    </main>
  );
}
