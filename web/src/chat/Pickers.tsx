import { useEffect, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import { ApiError } from '../api/errors';
import { t } from '../i18n/t';
import { closePicker, pageOf, type Picker } from './picker';

type Providers = Awaited<ReturnType<Client['models']>>['providers'];
const msg = (e: unknown) => (e instanceof ApiError ? e.message : t('error.generic'));

/** Step 1: providers. Step 2: that provider's models (paged, searchable). Choosing calls setmodel for this chat only; Back and Cancel are always there. */
export function ModelPicker({ client, picker, onDone }: { client: Client; picker: Picker; onDone: (text: string) => void }) {
  const [prov, setProv] = useState<Providers | null>(null), [err, setErr] = useState(''), [sel, setSel] = useState<string | null>(null), [q, setQ] = useState(''), [page, setPage] = useState(0), [busy, setBusy] = useState(false);
  useEffect(() => { let on = true; void client.models(picker.agent).then((r) => on && setProv(r.providers)).catch((e) => on && setErr(msg(e))); return () => { on = false; }; }, [picker.id]);
  const cancel = () => closePicker(picker.agent, picker.id);
  async function choose(slug: string, model: string) {
    if (!picker.session || busy) return; setBusy(true);
    try { const r = await client.setModel(picker.agent, picker.session, `${model}${slug ? ` --provider ${slug}` : ''}`); closePicker(picker.agent, picker.id); onDone(r?.confirm_required ? String(r.confirm_message ?? '') : t('picker.modelSet', { model })); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  }
  const p = prov?.find((x) => x.slug === sel);
  const all = p ? p.models.filter((m) => m.toLowerCase().includes(q.trim().toLowerCase())) : [];
  const pg = pageOf(all, page);
  return (
    <div class="card picker" role="group" aria-label={t('picker.model.title')} onKeyDown={(e) => { if (e.key === 'Escape') cancel(); }}>
      <p><b>{p ? t('picker.model.step2', { provider: p.name }) : t('picker.model.step1')}</b></p>
      {!picker.session && <p class="muted" role="note">{t('ctl.modelNeedsChat')}</p>}
      {!prov && !err && <p class="muted">{t('ctl.loading')}</p>}
      {prov && prov.length === 0 && <p class="muted">{t('ctl.noModels')}</p>}
      {prov && !p && <ul class="choices">{prov.map((x) => <li key={x.slug}><button class="btn outline" onClick={() => { setSel(x.slug); setQ(''); setPage(0); }}>{x.name}<small class="muted"> · {x.models.length}</small></button></li>)}</ul>}
      {p && (<>
        <input type="search" class="search" aria-label={t('picker.search')} placeholder={t('picker.search')} value={q} onInput={(e) => { setQ((e.currentTarget as HTMLInputElement).value); setPage(0); }} />
        {pg.rows.length === 0 && <p class="muted">{t('picker.none')}</p>}
        <ul class="choices">{pg.rows.map((m) => <li key={m}><button class="btn outline" disabled={!picker.session || busy} title={picker.session ? undefined : t('ctl.modelNeedsChat')} onClick={() => void choose(p.slug, m)}>{m}</button></li>)}</ul>
        {pg.pages > 1 && <div class="row pager"><button class="btn text" disabled={pg.page === 0} onClick={() => setPage(pg.page - 1)}>{t('picker.prev')}</button><small class="muted">{pg.page + 1}/{pg.pages}</small><button class="btn text" disabled={pg.page >= pg.pages - 1} onClick={() => setPage(pg.page + 1)}>{t('picker.next')}</button></div>}
      </>)}
      {err && <p class="error" role="alert">{err}</p>}
      <div class="row">{p && <button class="btn text" onClick={() => { setSel(null); setQ(''); }}>{t('picker.back')}</button>}<button class="btn text" onClick={cancel}>{t('picker.cancel')}</button></div>
    </div>
  );
}

/** Any command with fixed choices: tap one and it is sent as that command. */
export function ChoicePicker({ picker, onChoose }: { picker: Picker; onChoose: (text: string) => void }) {
  const cancel = () => closePicker(picker.agent, picker.id);
  return (
    <div class="card picker" role="group" aria-label={`/${picker.command}`} onKeyDown={(e) => { if (e.key === 'Escape') cancel(); }}>
      <p><b>/{picker.command}</b></p>
      <ul class="choices">{(picker.options ?? []).map((o) => <li key={o}><button class="btn outline" onClick={() => { closePicker(picker.agent, picker.id); onChoose(`/${picker.command} ${o}`); }}>{o}</button></li>)}</ul>
      <div class="row"><button class="btn text" onClick={cancel}>{t('picker.cancel')}</button></div>
    </div>
  );
}
