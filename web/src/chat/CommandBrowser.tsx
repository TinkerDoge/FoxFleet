import { Icon } from '../components/Icon';
import { useEffect, useRef, useState } from 'preact/hooks';
import { commandSuggestions, type Catalog, type Suggestion } from '../lib/commands';
import { t } from '../i18n/t';

/** Every useful command, searchable, including ones the composer hides until a name is typed. */
export function CommandBrowser(props: { skills: string[]; catalog: Catalog; onClose: () => void; onPick: (s: Suggestion) => void }) {
  const [q, setQ] = useState('');
  const [hidden, setHidden] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  const query = q.trim();
  const rows = commandSuggestions(query ? `/${query}` : '/', props.skills, Number.POSITIVE_INFINITY, true, props.catalog, hidden);
  return (
    <div class="cmd-browser" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); props.onClose(); } }}>
      <div class="panel" role="dialog" aria-modal="true" aria-label={t('chat.commandBrowser')}>
        <div class="head"><h2>{t('chat.commandBrowser')}</h2><button type="button" class="icon-btn" aria-label={t('admin.close')} onClick={props.onClose}><Icon name="close" /></button></div>
        <input ref={box} value={q} placeholder={t('chat.commandSearch')} aria-label={t('chat.commandSearch')} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
        <label><input type="checkbox" checked={hidden} onChange={(e) => setHidden((e.currentTarget as HTMLInputElement).checked)} /> {t('chat.showUnavailable')}</label>
        {rows.length === 0 ? <p class="note">{t('chat.noCommands')}</p> : (
          <ul>
            {rows.map((s, i) => <>
              {s.group && s.group !== rows[i - 1]?.group && <li class="grp" role="presentation">{s.group}</li>}
              <li key={s.label}><button type="button" aria-disabled={s.availability === 'unavailable' ? 'true' : undefined} class={s.availability === 'unavailable' ? 'off' : ''} onClick={() => props.onPick(s)}><b>{s.label}{s.args && <em> {s.args}</em>}</b><small>{s.hint}</small></button></li>
            </>)}
          </ul>
        )}
      </div>
    </div>
  );
}
