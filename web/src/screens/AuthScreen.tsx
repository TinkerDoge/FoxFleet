import { useState } from 'preact/hooks';
import { Wordmark } from '../components/Brand';
import { ErrorLine, Field, PrimaryButton, TextButton } from '../components/ui';
import { authModeFor } from '../lib/authMode';
import type { Client } from '../api/client';
import type { AuthInfo } from '../api/types';
import { ApiError, NetworkError, RateLimitedError } from '../api/errors';
import { t } from '../i18n/t';
import { FALLBACK_VERSION, PRIVACY_URL, TERMS_URL, rememberTerms, termsAccepted } from '../lib/terms';

export function AuthScreen({ client, info, hubLabel, invite = '', onDone, onChangeHub }: { client: Client; info: AuthInfo; hubLabel: string; invite?: string; onDone: () => void; onChangeHub?: () => void }) {
  const [wantsJoin, setWantsJoin] = useState(Boolean(invite));
  const mode = authModeFor(info, wantsJoin);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState(invite);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const version = info.termsVersion ?? FALLBACK_VERSION, needsTerms = mode !== 'signin';
  const [agreed, setAgreed] = useState(() => termsAccepted(hubLabel, version));
  const needsCode = (mode === 'setup' && info.setupCodeRequired) || mode === 'join';
  const ready = (!needsTerms || agreed) && username.trim().length > 0 && password.length > 0 && (!needsCode || code.trim().length > 0 || (mode === 'setup' && !info.setupCodeRequired));
  async function submit(e: Event) {
    e.preventDefault(); if (busy) return; setBusy(true); setError(null);
    try {
      const u = username.trim();
      if (mode === 'setup') await client.setup(u, password, code.trim() || undefined, version);
      else if (mode === 'join') await client.register(u, password, code.trim(), version);
      else await client.login(u, password);
      if (needsTerms) rememberTerms(hubLabel, version);
      onDone();
    } catch (err) {
      setError(err instanceof RateLimitedError ? t('auth.locked', { seconds: err.retryAfter }) : err instanceof NetworkError ? t('error.network')
        : err instanceof ApiError && err.status === 401 ? t('auth.invalid') : err instanceof ApiError ? err.message : t('error.generic'));
    } finally { setBusy(false); }
  }
  const title = mode === 'setup' ? t('auth.setup.title') : mode === 'join' ? t('auth.join.title') : t('auth.signin.title');
  const action = mode === 'setup' ? t('auth.setup.action') : mode === 'join' ? t('auth.join.action') : t('auth.signin.action');
  return (
    <main class="center-screen">
      <form class="stack" onSubmit={submit}>
        <Wordmark />
        <h1>{title}</h1>
        <p class="muted small">{hubLabel}</p>
        {mode === 'setup' && <p class="muted">{t('auth.setup.body')}</p>}
        <Field label={t('auth.username')} name="username" value={username} onInput={setUsername} autoComplete="username" autoFocus />
        <Field label={t('auth.password')} name="password" type="password" value={password} onInput={setPassword} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} hint={mode === 'signin' ? undefined : t('auth.passwordHint')} />
        {needsCode && <Field label={mode === 'setup' ? t('auth.setupCode') : t('auth.inviteCode')} name="code" value={code} onInput={setCode} hint={mode === 'setup' ? t('auth.setupCodeHint') : undefined} />}
        {needsTerms && (
          <label class="check"><input type="checkbox" name="terms" checked={agreed} onChange={(e) => setAgreed((e.currentTarget as HTMLInputElement).checked)} />
            <span>{t('auth.agree')} <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">{t('auth.terms')}</a> {t('auth.and')} <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">{t('auth.privacy')}</a>.</span></label>
        )}
        <ErrorLine message={error} />
        <PrimaryButton busy={busy} disabled={!ready}>{busy ? t('auth.working') : action}</PrimaryButton>
        {mode === 'signin' && info.registration !== 'closed' && <TextButton onClick={() => setWantsJoin(true)}>{t('auth.createAccount')}</TextButton>}
        {mode === 'join' && <TextButton onClick={() => setWantsJoin(false)}>{t('auth.haveAccount')}</TextButton>}
        {onChangeHub && <TextButton onClick={onChangeHub}>{t('hub.change')}</TextButton>}
      </form>
    </main>
  );
}
