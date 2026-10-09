import { useEffect, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import { ApiError, AuthRequiredError, NetworkError } from '../api/errors';
import type { AdminUser, Invite, Registration, Shareable } from '../api/types';
import { QrCode } from '../components/QrCode';
import { ErrorLine } from '../components/ui';
import { until } from '../lib/format';
import { t } from '../i18n/t';

const MODES: [Registration, Parameters<typeof t>[0]][] = [['closed', 'admin.closed'], ['invite', 'admin.invite'], ['open', 'admin.open']];
const fail = (e: unknown) => (e instanceof NetworkError ? t('error.network') : e instanceof ApiError ? e.message : t('error.generic'));

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return <button class="btn outline" type="button" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>{done ? t('chat.copied') : label}</button>;
}

/** Owner-only: pairing QR, registration mode, invites (copy link + QR), people (disable/enable). */
export function Admin({ client, onAuthLost }: { client: Client; onAuthLost: () => void }) {
  const [mode, setMode] = useState<Registration | null>(null), [pair, setPair] = useState<Shareable | null>(null), [invites, setInvites] = useState<Invite[]>([]), [users, setUsers] = useState<AdminUser[]>([]);
  const [fresh, setFresh] = useState<Shareable | null>(null), [error, setError] = useState<string | null>(null);
  const guard = async (fn: () => Promise<void>) => { setError(null); try { await fn(); } catch (e) { if (e instanceof AuthRequiredError) onAuthLost(); else setError(fail(e)); } };
  const load = () => guard(async () => { const [m, p, i, u] = await Promise.all([client.registrationMode(), client.pairing(), client.invites(), client.adminUsers()]); setMode(m); setPair(p); setInvites(i); setUsers(u); });
  useEffect(() => { void load(); }, []);
  return (
    <div class="page wide">
      <header class="page-head"><h1>{t('admin.title')}</h1></header>
      <ErrorLine message={error} />
      <section class="card stack" aria-labelledby="h-pair">
        <h2 id="h-pair">{t('admin.pair')}</h2><p class="muted">{t('admin.pairHint')}</p>
        {pair?.rows ? <QrCode rows={pair.rows} label={t('admin.pair')} /> : pair && <p class="muted">{t('error.generic')}</p>}
        {pair && <div class="row"><CopyButton text={pair.link} label={t('admin.copyLink')} /></div>}
      </section>
      <section class="card stack" aria-labelledby="h-who">
        <h2 id="h-who">{t('admin.who')}</h2>
        <div class="chips" role="radiogroup" aria-labelledby="h-who">{MODES.map(([m, key]) => <button key={m} type="button" role="radio" aria-checked={mode === m} class={`chip-btn${mode === m ? ' on' : ''}`} onClick={() => guard(async () => { await client.setRegistration(m); setMode(m); })}>{t(key)}</button>)}</div>
      </section>
      <section class="card stack" aria-labelledby="h-inv">
        <div class="row between"><h2 id="h-inv">{t('admin.invites')}</h2><button class="btn primary inline" onClick={() => guard(async () => { const s = await client.createInvite(); setFresh(s); setInvites(await client.invites()); })}>{t('admin.newInvite')}</button></div>
        {fresh && (
          <div class="invite-fresh" role="status"><p class="muted small">{t('admin.inviteLink')}</p>{fresh.rows && <QrCode rows={fresh.rows} label={t('admin.inviteLink')} size={168} />}<pre class="secret" tabIndex={0}>{fresh.link}</pre>
            <div class="row"><CopyButton text={fresh.link} label={t('admin.copyLink')} /><button class="btn text" onClick={() => setFresh(null)}>{t('admin.close')}</button></div></div>
        )}
        {invites.length === 0 && <p class="muted">{t('admin.noInvites')}</p>}
        <ul class="list inner">{invites.map((i) => <li class="static" key={i.id}><span class="grow"><b>{i.used ? t('admin.used') : i.id}</b><small class="muted">{t('admin.expires', { when: until(i.expires) })}</small></span>
          <button class="btn text danger" onClick={() => guard(async () => { await client.revokeInvite(i.id); setInvites(await client.invites()); })}>{t('admin.revoke')}</button></li>)}</ul>
      </section>
      <section class="card stack" aria-labelledby="h-ppl">
        <h2 id="h-ppl">{t('admin.people')}</h2>
        <ul class="list inner">{users.map((u) => <li class="static" key={u.id}><span class="grow"><b>{u.username}</b><small class="muted">{u.role === 'owner' ? 'Owner' : u.disabled ? t('admin.disabled') : 'Member'}</small></span>
          {u.role !== 'owner' && <button class="btn text" onClick={() => guard(async () => { await client.setUserDisabled(u.id, !u.disabled); setUsers(await client.adminUsers()); })}>{u.disabled ? t('admin.enable') : t('admin.disable')}</button>}</li>)}</ul>
      </section>
    </div>
  );
}
