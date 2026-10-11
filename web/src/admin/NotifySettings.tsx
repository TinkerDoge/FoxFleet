import { useEffect, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import type { AgentSummary } from '../api/types';
import { t } from '../i18n/t';
import { activeMutes, MUTE_CHOICES, type MuteRule, type NotifyPrefs } from '../lib/notify';

type Test = { s: 'idle' | 'sending' | 'ok' | 'muted' | 'slow' | 'fail'; error?: string };
const when = (m: MuteRule) => (m.until === null ? t('notify.untilForever') : t('notify.until', { time: new Date(m.until).toLocaleString([], { hour: '2-digit', minute: '2-digit', weekday: 'short' }) }));

/** Hub-side notification controls (the Android app reads the same prefs): master switch, agent mutes, test button. */
export function NotifySettings({ client }: { client: Client }) {
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [error, setError] = useState(false);
  const [pick, setPick] = useState(''), [dur, setDur] = useState('0');
  const [test, setTest] = useState<Test>({ s: 'idle' });
  useEffect(() => { let live = true; client.notifyPrefs().then((p) => live && setPrefs(p), () => live && setError(true)); client.agents().then((a) => live && setAgents(a), () => {}); return () => { live = false; }; }, [client]);
  const run = async (fn: () => Promise<NotifyPrefs>) => { try { setPrefs(await fn()); setError(false); } catch { setError(true); } };
  const rules = prefs ? activeMutes(prefs, Date.now()) : [];
  const label = (m: MuteRule) => (m.chat ? t('notify.chat', { chat: m.chat, name: m.agent }) : t('notify.agent', { name: m.agent }));
  const sendTest = async () => {
    setTest({ s: 'sending' });
    try { setTest({ s: (await client.notifyTest()).muted ? 'muted' : 'ok' }); }
    catch (e: any) { setTest(e?.status === 429 || e?.name === 'RateLimitedError' ? { s: 'slow' } : { s: 'fail', error: String(e?.message ?? e).slice(0, 120) }); }
  };
  return (
    <section class="card stack" aria-labelledby="h-notify">
      <h2 id="h-notify">{t('notify.title')}</h2>
      <p class="muted small">{t('notify.intro')}</p>
      {error && <p class="error" role="alert">{t('notify.loadFail')}</p>}
      {prefs && <>
        <label class="row-check"><input type="checkbox" role="switch" checked={prefs.enabled} onChange={(e) => run(() => client.setNotifyEnabled((e.currentTarget as HTMLInputElement).checked))} /> {t('notify.master')}</label>
        {!prefs.enabled && <p class="muted small">{t('notify.masterOff')}</p>}
        {!prefs.storageOk && <p class="muted small" role="note">{t('notify.storage')}</p>}
        <h3>{t('notify.mutes')}</h3>
        {rules.length === 0 ? <p class="muted small">{t('notify.none')}</p> : <ul class="plain">{rules.map((m) => <li key={`${m.agent}/${m.chat}`} class="row">
          <span>{label(m)} <span class="muted small">({when(m)})</span></span>
          <button type="button" class="btn text" aria-label={t('notify.unmuteAgent', { name: label(m) })} onClick={() => run(() => client.notifyMute(m.agent, m.chat, false))}>{t('notify.unmute')}</button>
        </li>)}</ul>}
        <div class="row" role="group" aria-label={t('notify.muteAgent')}>
          <select aria-label={t('notify.pickAgent')} value={pick} onChange={(e) => setPick((e.currentTarget as HTMLSelectElement).value)}>
            <option value="">{t('notify.pickAgent')}</option>{agents.map((a) => <option key={a.name} value={a.name}>{a.displayName ?? a.name}</option>)}
          </select>
          <select aria-label={t('notify.mute')} value={dur} onChange={(e) => setDur((e.currentTarget as HTMLSelectElement).value)}>{MUTE_CHOICES.map((c, i) => <option key={c.key} value={String(i)}>{t(c.key)}</option>)}</select>
          <button type="button" class="btn" disabled={!pick} onClick={() => run(() => client.notifyMute(pick, null, true, MUTE_CHOICES[Number(dur)].ms ?? undefined))}>{t('notify.mute')}</button>
        </div>
        <div>
          <button type="button" class="btn" disabled={test.s === 'sending'} onClick={sendTest}>{test.s === 'sending' ? t('notify.testing') : t('notify.test')}</button>
          <p class="muted small" role="status" aria-live="polite">{test.s === 'ok' ? t('notify.testOk') : test.s === 'muted' ? t('notify.testMuted') : test.s === 'slow' ? t('notify.testSlow') : test.s === 'fail' ? t('notify.testFail', { error: test.error ?? '' }) : ''}</p>
        </div>
      </>}
    </section>
  );
}
