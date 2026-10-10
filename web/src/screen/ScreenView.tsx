import { useEffect, useRef, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import { AuthRequiredError } from '../api/errors';
import type { AgentSummary } from '../api/types';
import { t } from '../i18n/t';
import { attachControls } from './controls.js';
import { screenProblem, type ScreenProblem } from './problems';

type Phase = 'connecting' | 'live' | 'closed' | 'error';
const KEYS: [string, string][] = [['Escape', 'Esc'], ['Tab', 'Tab'], ['Enter', 'Enter'], ['Backspace', '⌫'], ['Up', '↑'], ['Down', '↓'], ['Left', '←'], ['Right', '→']];
export const TAKEOVER_TICK_MS = 1000;
export const fmtCountdown = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/**
 * Bot Screen: noVNC (lazy-loaded) against the hub's single-use-ticket relay. View-only until "Take over";
 * control ends on Hand back, on the auto hand-back deadline, and whenever this view is left or the page closes.
 */
export function ScreenView({ client, agent, onAuthLost, onClose, hubKnown = true }: { client: Client; agent: AgentSummary; onAuthLost: () => void; onClose: () => void; /** false when the hub's /api/auth has no hub block (older than 0.3.5) */ hubKnown?: boolean }) {
  const host = useRef<HTMLDivElement>(null), rfb = useRef<any>(null), keys = useRef<Record<string, number>>({}), kbd = useRef<HTMLTextAreaElement>(null), controlling = useRef(false);
  const ctl = useRef<ReturnType<typeof attachControls> | null>(null), [ui, setUi] = useState<{ zoom: string; pan: boolean; mods: Record<string, boolean> }>({ zoom: 'fit', pan: false, mods: {} }), [problem, setProblem] = useState<(ScreenProblem & { detail?: string; list?: string }) | null>(null);
  const [phase, setPhase] = useState<Phase>('connecting'), [error, setError] = useState<string | null>(null), [control, setControl] = useState(false), [until, setUntil] = useState(0), [now, setNow] = useState(Date.now()), [busy, setBusy] = useState(false);
  const name = agent.displayName || agent.name;

  async function handBack(silent = false) {
    if (!controlling.current) return; controlling.current = false; setControl(false); setUntil(0);
    if (rfb.current) rfb.current.viewOnly = true;
    try { await client.screen(agent.name, 'handback'); } catch (e) { if (!silent) setError(t('screen.handbackFailed')); }
  }
  async function connect() {
    setPhase('connecting'); setError(null); setProblem(null);
    try {
      const st = await client.screen(agent.name, 'status');
      if (st.state && st.state !== 'ok' && st.state !== 'stopped') { setPhase('error'); return setProblem({ ...screenProblem({ state: st.state, hubKnown }), detail: st.blocker ?? undefined, list: st.missing?.join(', ') }); }
      if (!st.supported) { setPhase('error'); return setProblem({ ...screenProblem({ state: 'no_vnc', hubKnown }), detail: st.blocker ?? undefined }); }
      if (!st.running) await client.screen(agent.name, 'start');
      const [{ default: RFB }, { default: KeyTable }, { ticket }] = await Promise.all([import('../vendor/novnc/core/rfb.js'), import('../vendor/novnc/core/input/keysym.js'), client.screenTicket(agent.name)]);
      keys.current = { Escape: KeyTable.XK_Escape, Tab: KeyTable.XK_Tab, Enter: KeyTable.XK_Return, Backspace: KeyTable.XK_BackSpace, Up: KeyTable.XK_Up, Down: KeyTable.XK_Down, Left: KeyTable.XK_Left, Right: KeyTable.XK_Right };
      if (!host.current) return; try { rfb.current?.disconnect(); } catch { /* already closed */ }
      const r = new RFB(host.current, client.screenUrl(agent.name, ticket), { shared: true });
      r.viewOnly = true; r.scaleViewport = true; r.resizeSession = false; r.focusOnClick = false; r.background = '#0b0b0c'; rfb.current = r;
      ctl.current?.detach(); ctl.current = attachControls(host.current, () => rfb.current, { onChange: setUi }); ctl.current.setZoom('fit');
      r.addEventListener('connect', () => setPhase('live'));
      r.addEventListener('disconnect', (e: CustomEvent) => { controlling.current = false; setControl(false); setPhase(e.detail?.clean ? 'closed' : 'error'); if (!e.detail?.clean) setError(t('screen.lost')); });
      r.addEventListener('securityfailure', () => { setPhase('error'); setError(t('screen.lost')); });
    } catch (e) { if (e instanceof AuthRequiredError) return onAuthLost(); setPhase('error'); fail(e); }
  }
  /** Turn any failure into a named, actionable problem (never a blank view). */
  function fail(e: unknown) {
    const x = e as { status?: number; code?: string; message?: string; name?: string };
    const p = screenProblem({ status: x.status, code: x.code, network: x.name === 'NetworkError', hubKnown });
    setProblem({ ...p, detail: p.kind === 'generic' ? x.message : undefined });
  }
  useEffect(() => {
    void connect();
    const leave = () => { if (controlling.current) void client.screen(agent.name, 'handback', { keepalive: true }); };
    addEventListener('pagehide', leave);
    return () => { ctl.current?.detach(); removeEventListener('pagehide', leave); if (controlling.current) { controlling.current = false; void client.screen(agent.name, 'handback').catch(() => {}); } try { rfb.current?.disconnect(); } catch { /* ignore */ } rfb.current = null; };
  }, [agent.name]);
  useEffect(() => { if (!until) return; const id = setInterval(() => { setNow(Date.now()); if (Date.now() >= until) void handBack(); }, TAKEOVER_TICK_MS); return () => clearInterval(id); }, [until]);

  async function takeOver(retry = true): Promise<void> {
    setBusy(true); setError(null);
    try { const r = await client.screen<{ autoHandBackAt?: number }>(agent.name, 'takeover'); controlling.current = true; setControl(true); setNow(Date.now()); setUntil(r.autoHandBackAt ?? Date.now() + 5 * 60_000); if (rfb.current) { rfb.current.viewOnly = false; rfb.current.focus(); } }
    catch (e) {
      if (e instanceof AuthRequiredError) return onAuthLost();
      if ((e as { code?: string }).code === 'reopen' && retry) { setBusy(false); await connect(); return takeOver(false); } // the hub's session to the agent was recycled: re-open the screen, then take over once more
      const p = screenProblem({ status: (e as { status?: number }).status, code: (e as { code?: string }).code, hubKnown }); setError(p.kind === 'generic' ? (e instanceof Error && e.message ? e.message : t('screen.takeoverFailed')) : t(`screen.err.${p.kind}`));
    }
    finally { setBusy(false); }
  }
  const sendKey = (k: string) => { if (control) ctl.current?.press(k); };
  function typed() { const el = kbd.current; if (!el || !control) return; ctl.current?.type(el.value); el.value = ''; }

  return (
    <section class={`screen${control ? ' control' : ''}`} aria-label={t('screen.title', { agent: name })}>
      <header class="chat-head">
        <button class="btn text" onClick={() => void handBack(true).finally(onClose)}>← {t('screen.back')}</button>
        <div class="grow"><b>{t('screen.title', { agent: name })}</b>
          <small class="muted" role="status" aria-live="polite">{phase === 'connecting' ? t('screen.connecting') : control ? t('screen.controlling', { time: fmtCountdown(until - now) }) : phase === 'live' ? t('screen.viewing') : t('screen.disconnected')}</small></div>
        {phase === 'live' && !control && <button class="btn primary inline" disabled={busy} onClick={() => void takeOver()}>{t('screen.takeover')}</button>}
        {control && <button class="btn primary inline danger-solid" onClick={() => void handBack()}>{t('screen.handback')}</button>}
        {(phase === 'closed' || phase === 'error') && <button class="btn outline" onClick={() => void connect()}>{t('screen.reconnect')}</button>}
      </header>
      {error && !problem && <p class="error pad" role="alert">{error}</p>}
      <div class="screen-stage"><div ref={host} class="screen-host" aria-label={t('screen.canvas')} />{phase === 'connecting' && <p class="muted center overlay">{t('screen.connecting')}</p>}
        {problem && <div class="overlay screen-problem" role="alert"><div class="screen-problem-card"><b>{t(`screen.err.${problem.kind}`, { detail: problem.detail ?? '' })}</b>
          {problem.list && <p class="small">{t('screen.err.missing', { list: problem.list })}</p>}
          {problem.kind === 'generic' && problem.detail && <p class="small muted">{problem.detail}</p>}
          {problem.update && <p class="small">{t('screen.err.update')}</p>}
          <button class="btn primary inline" onClick={() => void connect()}>{t('screen.reconnect')}</button></div></div>}
      </div>
      {control && (
        <div class="keys" role="toolbar" aria-label={t('screen.keys')}>
          {KEYS.map(([k, label]) => <button key={k} class="chip-btn" onClick={() => sendKey(k)} aria-label={k}>{label}</button>)}
          {(['ctrl', 'alt', 'shift'] as const).map((m) => <button key={m} class={`chip-btn${ui.mods[m] ? ' on' : ''}`} aria-pressed={Boolean(ui.mods[m])} onClick={() => ctl.current?.toggleMod(m)}>{t(`screen.${m}`)}</button>)}
          <button class="chip-btn" onClick={() => rfb.current?.sendCtrlAltDel()}>Ctrl+Alt+Del</button>
          <button class="chip-btn" onClick={() => ctl.current?.setZoom(ui.zoom === 'fit' ? '100' : 'fit')} aria-label={ui.zoom === 'fit' ? t('screen.zoomIn') : t('screen.zoomFit')}>{ui.zoom === 'fit' ? '100%' : t('screen.zoomFit')}</button>
          {ui.zoom !== 'fit' && <button class={`chip-btn${ui.pan ? ' on' : ''}`} aria-pressed={ui.pan} onClick={() => ctl.current?.setPan(!ui.pan)}>Pan</button>}
          <button class="chip-btn" onClick={() => kbd.current?.focus()}>{t('screen.keyboard')}</button>
          <textarea ref={kbd} class="sr-only" aria-label={t('screen.typeHere')} onInput={typed} onKeyDown={(e) => { if (e.key === 'Backspace') { sendKey('Backspace'); e.preventDefault(); } }} />
          <p class="small muted keys-help">{t('screen.help')}</p>
        </div>
      )}
    </section>
  );
}
