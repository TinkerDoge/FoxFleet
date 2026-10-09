import { useEffect, useRef, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import { AuthRequiredError } from '../api/errors';
import type { AgentSummary } from '../api/types';
import { t } from '../i18n/t';

type Phase = 'connecting' | 'live' | 'closed' | 'error';
const KEYS: [string, string][] = [['Escape', 'Esc'], ['Tab', 'Tab'], ['Enter', 'Enter'], ['Backspace', '⌫'], ['Up', '↑'], ['Down', '↓'], ['Left', '←'], ['Right', '→']];
export const TAKEOVER_TICK_MS = 1000;
export const fmtCountdown = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/**
 * Bot Screen: noVNC (lazy-loaded) against the hub's single-use-ticket relay. View-only until "Take over";
 * control ends on Hand back, on the auto hand-back deadline, and whenever this view is left or the page closes.
 */
export function ScreenView({ client, agent, onAuthLost, onClose }: { client: Client; agent: AgentSummary; onAuthLost: () => void; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null), rfb = useRef<any>(null), keys = useRef<Record<string, number>>({}), kbd = useRef<HTMLTextAreaElement>(null), controlling = useRef(false);
  const [phase, setPhase] = useState<Phase>('connecting'), [error, setError] = useState<string | null>(null), [control, setControl] = useState(false), [until, setUntil] = useState(0), [now, setNow] = useState(Date.now()), [busy, setBusy] = useState(false);
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const name = agent.displayName || agent.name;

  async function handBack(silent = false) {
    if (!controlling.current) return; controlling.current = false; setControl(false); setUntil(0);
    if (rfb.current) rfb.current.viewOnly = true;
    try { await client.screen(agent.name, 'handback'); } catch (e) { if (!silent) setError(t('screen.handbackFailed')); }
  }
  async function connect() {
    setPhase('connecting'); setError(null);
    try {
      const st = await client.screen(agent.name, 'status');
      if (!st.supported) { setPhase('error'); return setError(st.blocker || t('screen.unsupported')); }
      if (!st.running) await client.screen(agent.name, 'start');
      const [{ default: RFB }, { default: KeyTable }, { ticket }] = await Promise.all([import('../vendor/novnc/core/rfb.js'), import('../vendor/novnc/core/input/keysym.js'), client.screenTicket(agent.name)]);
      keys.current = { Escape: KeyTable.XK_Escape, Tab: KeyTable.XK_Tab, Enter: KeyTable.XK_Return, Backspace: KeyTable.XK_BackSpace, Up: KeyTable.XK_Up, Down: KeyTable.XK_Down, Left: KeyTable.XK_Left, Right: KeyTable.XK_Right };
      if (!host.current) return; try { rfb.current?.disconnect(); } catch { /* already closed */ }
      const r = new RFB(host.current, client.screenUrl(agent.name, ticket), { shared: true });
      r.viewOnly = true; r.scaleViewport = true; r.resizeSession = false; r.focusOnClick = false; r.background = '#0b0b0c'; rfb.current = r;
      r.addEventListener('connect', () => setPhase('live'));
      r.addEventListener('disconnect', (e: CustomEvent) => { controlling.current = false; setControl(false); setPhase(e.detail?.clean ? 'closed' : 'error'); if (!e.detail?.clean) setError(t('screen.lost')); });
      r.addEventListener('securityfailure', () => { setPhase('error'); setError(t('screen.lost')); });
    } catch (e) { if (e instanceof AuthRequiredError) return onAuthLost(); setPhase('error'); setError(e instanceof Error && e.message ? e.message : t('error.generic')); }
  }
  useEffect(() => {
    void connect();
    const leave = () => { if (controlling.current) void client.screen(agent.name, 'handback', { keepalive: true }); };
    addEventListener('pagehide', leave);
    return () => { removeEventListener('pagehide', leave); if (controlling.current) { controlling.current = false; void client.screen(agent.name, 'handback').catch(() => {}); } try { rfb.current?.disconnect(); } catch { /* ignore */ } rfb.current = null; };
  }, [agent.name]);
  useEffect(() => { if (!until) return; const id = setInterval(() => { setNow(Date.now()); if (Date.now() >= until) void handBack(); }, TAKEOVER_TICK_MS); return () => clearInterval(id); }, [until]);

  async function takeOver() {
    setBusy(true); setError(null);
    try { const r = await client.screen<{ autoHandBackAt?: number }>(agent.name, 'takeover'); controlling.current = true; setControl(true); setNow(Date.now()); setUntil(r.autoHandBackAt ?? Date.now() + 5 * 60_000); if (rfb.current) { rfb.current.viewOnly = false; rfb.current.focus(); } }
    catch (e) { if (e instanceof AuthRequiredError) return onAuthLost(); setError(e instanceof Error && e.message ? e.message : t('screen.takeoverFailed')); }
    finally { setBusy(false); }
  }
  const sendKey = (k: string) => { if (control && keys.current[k]) rfb.current?.sendKey(keys.current[k], k); };
  function typed() { const el = kbd.current; if (!el || !control) return; for (const ch of el.value) { const c = ch.codePointAt(0)!; ch === '\n' ? sendKey('Enter') : rfb.current?.sendKey(c < 256 ? c : 0x01000000 | c); } el.value = ''; }

  return (
    <section class={`screen${control ? ' control' : ''}`} aria-label={t('screen.title', { agent: name })}>
      <header class="chat-head">
        <button class="btn text" onClick={() => void handBack(true).finally(onClose)}>← {t('screen.back')}</button>
        <div class="grow"><b>{t('screen.title', { agent: name })}</b>
          <small class="muted" role="status" aria-live="polite">{phase === 'connecting' ? t('screen.connecting') : control ? t('screen.controlling', { time: fmtCountdown(until - now) }) : phase === 'live' ? t('screen.viewing') : t('screen.disconnected')}</small></div>
        {phase === 'live' && !control && <button class="btn primary inline" disabled={busy} onClick={takeOver}>{t('screen.takeover')}</button>}
        {control && <button class="btn primary inline danger-solid" onClick={() => void handBack()}>{t('screen.handback')}</button>}
        {(phase === 'closed' || phase === 'error') && <button class="btn outline" onClick={() => void connect()}>{t('screen.reconnect')}</button>}
      </header>
      {error && <p class="error pad" role="alert">{error}</p>}
      <div class="screen-stage"><div ref={host} class="screen-host" aria-label={t('screen.canvas')} />{phase === 'connecting' && <p class="muted center overlay">{t('screen.connecting')}</p>}</div>
      {control && (
        <div class="keys" role="toolbar" aria-label={t('screen.keys')}>
          {KEYS.map(([k, label]) => <button key={k} class="chip-btn" onClick={() => sendKey(k)} aria-label={k}>{label}</button>)}
          <button class="chip-btn" onClick={() => rfb.current?.sendCtrlAltDel()}>Ctrl+Alt+Del</button>
          {touch && <button class="chip-btn" onClick={() => kbd.current?.focus()}>{t('screen.keyboard')}</button>}
          <textarea ref={kbd} class="sr-only" aria-label={t('screen.typeHere')} onInput={typed} onKeyDown={(e) => { if (e.key === 'Backspace') { sendKey('Backspace'); e.preventDefault(); } }} />
        </div>
      )}
    </section>
  );
}
