import { useState } from 'preact/hooks';
import { displayHub, getPrefs, setAccent, setMotion, setTextSize, setTheme, type Prefs } from '../state';
import { t } from '../i18n/t';

export const ACCENTS: { id: string; name: string; color: string }[] = [
  { id: 'ember', name: 'Ember', color: '#BE4A21' }, { id: 'ocean', name: 'Ocean', color: '#2A64C6' }, { id: 'moss', name: 'Moss', color: '#2F7A4B' }, { id: 'iris', name: 'Iris', color: '#7457D8' }, { id: 'graphite', name: 'Graphite', color: '#3A3A3A' },
];
function Choice<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: [T, string][]; onPick: (v: T) => void }) {
  return <fieldset class="field enum"><legend>{label}</legend><div class="chips" role="radiogroup" aria-label={label}>{options.map(([v, name]) => <button key={v} type="button" role="radio" aria-checked={value === v} class={`chip-btn${value === v ? ' on' : ''}`} onClick={() => onPick(v)}>{name}</button>)}</div></fieldset>;
}
/** Theme, accent, text size, motion: stored on this device only. */
export function Settings({ hub }: { hub: string }) {
  const [p, setP] = useState<Prefs>(getPrefs());
  const upd = (fn: () => void) => { fn(); setP(getPrefs()); };
  return (
    <div class="page wide">
      <header class="page-head"><h1>{t('settings.title')}</h1></header>
      <section class="card stack" aria-labelledby="h-app">
        <h2 id="h-app">{t('settings.appearance')}</h2>
        <Choice label={t('settings.theme')} value={p.theme} options={[['system', t('settings.system')], ['light', t('settings.light')], ['dark', t('settings.dark')]]} onPick={(v) => upd(() => setTheme(v))} />
        <fieldset class="field enum"><legend>{t('settings.accent')}</legend>
          <div class="chips" role="radiogroup" aria-label={t('settings.accent')}>{ACCENTS.map((a) => <button key={a.id} type="button" role="radio" aria-checked={p.accent === a.id} aria-label={a.name} title={a.name} class={`swatch${p.accent === a.id ? ' on' : ''}`} style={{ background: a.color }} onClick={() => upd(() => setAccent(a.id))} />)}</div></fieldset>
        <Choice label={t('settings.text')} value={p.text} options={[['small', t('settings.small')], ['normal', t('settings.normal')], ['large', t('settings.large')]]} onPick={(v) => upd(() => setTextSize(v))} />
        <Choice label={t('settings.motion')} value={p.motion} options={[['system', t('settings.motionSystem')], ['reduce', t('settings.motionReduce')]]} onPick={(v) => upd(() => setMotion(v))} />
      </section>
      <section class="card stack"><h2>{t('settings.hub')}</h2><p class="muted">{displayHub(hub)}</p><p class="muted small">{t('settings.about')}</p></section>
    </div>
  );
}
