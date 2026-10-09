import { useEffect, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import { ApiError, AuthRequiredError, NetworkError, RateLimitedError } from '../api/errors';
import type { Device } from '../api/types';
import { ErrorLine, Field, PrimaryButton } from '../components/ui';
import { ago } from '../lib/format';
import { t } from '../i18n/t';

export const passwordProblem = (current: string, next: string, again: string): string | null => !current || !next ? null : next !== again ? t('account.mismatch') : next.length < 10 ? t('auth.passwordShort') : null;
const fail = (e: unknown) => (e instanceof RateLimitedError ? t('auth.locked', { seconds: e.retryAfter }) : e instanceof NetworkError ? t('error.network') : e instanceof ApiError ? e.message : t('error.generic'));

/** Device list with revoke, sign out everywhere, and change password. */
export function Account({ client, onAuthLost }: { client: Client; onAuthLost: () => void }) {
  const [devices, setDevices] = useState<Device[]>([]), [error, setError] = useState<string | null>(null), [current, setCurrent] = useState(''), [next, setNext] = useState(''), [again, setAgain] = useState(''), [busy, setBusy] = useState(false), [ok, setOk] = useState(false);
  const guard = async (fn: () => Promise<void>) => { setError(null); try { await fn(); } catch (e) { if (e instanceof AuthRequiredError) onAuthLost(); else setError(fail(e)); } };
  const load = () => guard(async () => setDevices(await client.devices()));
  useEffect(() => { void load(); }, []);
  const problem = passwordProblem(current, next, again);
  return (
    <div class="page wide">
      <header class="page-head"><h1>{t('account.title')}</h1></header>
      <ErrorLine message={error} />
      <section class="card stack" aria-labelledby="h-dev">
        <h2 id="h-dev">{t('account.devices')}</h2>
        <ul class="list inner">{devices.map((d) => <li class="static" key={d.id}><span class="grow"><b>{d.name}{d.current ? ` · ${t('account.thisDevice')}` : ''}</b><small class="muted">{d.kind === 'app' ? 'App' : 'Browser'} · {t('account.lastSeen', { when: ago(d.lastSeen) })}</small></span>
          <button class="btn text danger" onClick={() => guard(async () => { const self = await client.revokeDevice(d.id); if (self) onAuthLost(); else setDevices(await client.devices()); })}>{t('account.signOut')}</button></li>)}</ul>
        <p class="muted small">{t('account.signOutAllHint')}</p>
        <div><button class="btn outline" onClick={() => guard(async () => { await client.logoutAll(); onAuthLost(); })}>{t('account.signOutAll')}</button></div>
      </section>
      <form class="card stack" aria-labelledby="h-pw" onSubmit={(e) => { e.preventDefault(); if (problem || !current || !next) return; setBusy(true); setOk(false); void guard(async () => { await client.changePassword(current, next); setCurrent(''); setNext(''); setAgain(''); setOk(true); setDevices(await client.devices()); }).finally(() => setBusy(false)); }}>
        <h2 id="h-pw">{t('account.password')}</h2>
        <Field label={t('account.current')} name="current" type="password" value={current} onInput={setCurrent} autoComplete="current-password" />
        <Field label={t('account.next')} name="next" type="password" value={next} onInput={setNext} autoComplete="new-password" hint={t('auth.passwordHint')} />
        <Field label={t('account.confirm')} name="again" type="password" value={again} onInput={setAgain} autoComplete="new-password" />
        {problem && <p class="muted small" role="status">{problem}</p>}
        {ok && <p class="ok-line" role="status">{t('account.changed')}</p>}
        <PrimaryButton busy={busy} disabled={Boolean(problem) || !current || !next}>{t('account.change')}</PrimaryButton>
      </form>
    </div>
  );
}
