import { useEffect, useState } from 'preact/hooks';
import type { Client, SendMode } from '../api/client';
import { ApiError } from '../api/errors';
import { t } from '../i18n/t';

type Providers = Awaited<ReturnType<Client['models']>>['providers'];
/** Native-only controls. Everything here says why it is disabled instead of hiding. */
export function ChatControls({ client, agent, session, streaming }: { client: Client; agent: string; session?: string; streaming: boolean }) {
  const [open, setOpen] = useState(false), [prov, setProv] = useState<Providers | null>(null), [busyMode, setBusyMode] = useState<string>(''), [note, setNote] = useState(''), [err, setErr] = useState('');
  const [pick, setPick] = useState('');
  const msg = (e: unknown) => (e instanceof ApiError ? e.message : t('error.generic'));
  useEffect(() => { if (!open) return; setErr(''); void client.models(agent).then((r) => setProv(r.providers)).catch((e) => setErr(msg(e))); void client.profileBusy(agent).then(setBusyMode).catch(() => {}); }, [open, agent]);
  const why = !session ? t('ctl.modelNeedsChat') : streaming ? t('ctl.modelBusy') : '';
  async function apply() {
    const [slug, ...m] = pick.split('\u0000'), model = m.join('\u0000'); if (!session || !model) return;
    try { const r = await client.setModel(agent, session, `${model}${slug ? ` --provider ${slug}` : ''}`); setNote(r?.confirm_required ? String(r.confirm_message ?? '') : t('ctl.modelSet', { model })); setErr(''); } catch (e) { setErr(msg(e)); }
  }
  async function changeBusy(mode: SendMode) {
    if (!confirm(t('ctl.busyConfirm'))) return;
    try { await client.setProfileBusy(agent, mode); setBusyMode(mode); setErr(''); } catch (e) { setErr(t('ctl.busyFailed', { error: msg(e) })); }
  }
  return (
    <span class="controls">
      <button class="btn text" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>{t('ctl.open')}</button>
      {open && (
        <div class="card popover" role="dialog" aria-label={t('ctl.title')} onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>
          <h3>{t('ctl.model')}</h3>
          <p class="muted">{t('ctl.modelHelp')}</p>
          {!prov && !err && <p class="muted">{t('ctl.loading')}</p>}
          {prov && prov.length === 0 && <p class="muted">{t('ctl.noModels')}</p>}
          {prov && prov.length > 0 && (
            <div class="row">
              <select aria-label={t('ctl.model')} disabled={!!why} value={pick} onChange={(e) => setPick((e.currentTarget as HTMLSelectElement).value)} title={why || undefined}>
                <option value="">—</option>
                {prov.map((p) => <optgroup key={p.slug} label={p.name}>{p.models.map((m) => <option key={m} value={`${p.slug}\u0000${m}`}>{m}</option>)}</optgroup>)}
              </select>
              <button class="btn" disabled={!!why || !pick} title={why || undefined} onClick={() => void apply()}>{t('ctl.set')}</button>
            </div>
          )}
          {why && <p class="muted" role="note">{why}</p>}
          {note && <p role="status">{note}</p>}
          <hr />
          <h3>{t('ctl.busyTitle')}</h3>
          <p class="warn" role="note">{t('ctl.busyWarn')}</p>
          {busyMode && <p>{t('ctl.busyNow', { mode: t((busyMode === 'interrupt' ? 'chat.mode.interrupt.native' : 'chat.mode.' + (['queue', 'steer'].includes(busyMode) ? busyMode : 'queue')) as Parameters<typeof t>[0]) })}</p>}
          <div class="row">{(['queue', 'steer', 'interrupt'] as SendMode[]).map((m) => <button key={m} class="btn text" disabled={busyMode === m} onClick={() => void changeBusy(m)}>{t((m === 'interrupt' ? 'chat.mode.interrupt.native' : 'chat.mode.' + m) as Parameters<typeof t>[0])}</button>)}</div>
          {err && <p class="error" role="alert">{err}</p>}
          <button class="btn text" onClick={() => setOpen(false)}>{t('ctl.close')}</button>
        </div>
      )}
    </span>
  );
}
