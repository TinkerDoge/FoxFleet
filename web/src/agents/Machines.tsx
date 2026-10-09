import { useEffect, useRef, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import type { Machine, Pairing } from '../api/types';
import { ApiError, AuthRequiredError, NetworkError } from '../api/errors';
import { QrCode } from '../components/QrCode';
import { ErrorLine, TextButton } from '../components/ui';
import { ago, until } from '../lib/format';
import { t } from '../i18n/t';

const fail = (e: unknown) => (e instanceof NetworkError ? t('error.network') : e instanceof ApiError ? e.message : t('error.generic'));

function Copy({ text, label = t('machines.copy') }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return <button class="btn outline" type="button" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>{done ? t('chat.copied') : label}</button>;
}
export const profileLine = (m: Machine) => (m.profiles.length ? m.profiles.map((p) => p.agent).join(', ') : t('machines.noProfiles'));
export const foundLine = (m: Machine) => (m.profiles.length === 1 ? t('machines.found1', { names: profileLine(m) }) : t('machines.found', { n: m.profiles.length, names: profileLine(m) }));

/** Owner screen section: connected machines (status, profiles, last seen) and the "Connect a machine" flow. */
export function Machines({ client, onChanged, onAuthLost }: { client: Client; onChanged: () => void; onAuthLost: () => void }) {
  const [list, setList] = useState<Machine[] | null>(null), [error, setError] = useState<string | null>(null), [pairing, setPairing] = useState<{ p: Pairing; machineId?: string } | null>(null);
  const guard = async (fn: () => Promise<void>) => { try { setError(null); await fn(); } catch (e) { if (e instanceof AuthRequiredError) onAuthLost(); else setError(fail(e)); } };
  const load = () => guard(async () => setList(await client.machines()));
  useEffect(() => { void load(); const id = setInterval(() => { if (!pairing) void load(); }, 8000); return () => clearInterval(id); }, [pairing]);
  const start = (machineId?: string) => guard(async () => setPairing({ p: machineId ? await client.rotateMachine(machineId) : await client.createPairing(), machineId }));
  const rename = (m: Machine) => { const name = prompt(t('machines.newName'), m.name)?.trim(); if (name && name !== m.name) void guard(async () => { await client.renameMachine(m.id, name); await load(); }); };
  const revoke = (m: Machine) => { if (confirm(t('machines.confirmRevoke', { name: m.name }))) void guard(async () => { await client.revokeMachine(m.id); await load(); onChanged(); }); };
  if (pairing) return <PairPanel client={client} first={pairing.p} machineId={pairing.machineId} onClose={() => { setPairing(null); void load(); onChanged(); }} onAuthLost={onAuthLost} />;
  return (
    <section class="card stack" aria-labelledby="machines-h">
      <div class="row between"><h2 id="machines-h">{t('machines.title')}</h2><button class="btn primary inline" onClick={() => start()}>{t('machines.connect')}</button></div>
      <p class="muted small">{t('machines.intro')}</p>
      <ErrorLine message={error} />
      {list?.length === 0 && <p class="muted">{t('machines.empty')}</p>}
      {list && list.length > 0 && (
        <ul class="list inner">
          {list.map((m) => (
            <li class="static" key={m.id}>
              <span class="grow"><b>{m.name}</b>
                <small class="muted"><span class={`dot ${m.online ? 'on' : 'off'}`} aria-hidden="true" /> {m.online ? t('machines.online') : t('machines.offline')} · {m.lastSeen ? t('machines.lastSeen', { when: m.online ? ago(Date.now()) : ago(m.lastSeen) }) : t('machines.never')}</small>
                <small class="muted">{profileLine(m)}</small></span>
              <button class="btn text" onClick={() => rename(m)}>{t('machines.rename')}</button>
              <button class="btn text" onClick={() => start(m.id)}>{t('machines.repair')}</button>
              <button class="btn text danger" onClick={() => revoke(m)}>{t('machines.revoke')}</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PairPanel({ client, first, machineId, onClose, onAuthLost }: { client: Client; first: Pairing; machineId?: string; onClose: () => void; onAuthLost: () => void }) {
  const [p, setP] = useState(first), [tab, setTab] = useState<'sh' | 'powershell' | 'node'>('sh'), [state, setState] = useState<'waiting' | 'expired' | 'paired'>('waiting'), [machine, setMachine] = useState<Machine | null>(null), [error, setError] = useState<string | null>(null);
  const live = useRef(true); useEffect(() => () => { live.current = false; }, []);
  useEffect(() => {
    if (state === 'expired') return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await client.pairingStatus(p.code); if (stop || !live.current) return;
        if (s.state === 'paired') { setState('paired'); const m = (await client.machines()).find((x) => x.id === (s.machine?.id)) ?? s.machine ?? null; if (m) setMachine(m); }
        else setState(s.state);
      } catch (e) { if (e instanceof AuthRequiredError) onAuthLost(); }
    };
    void tick(); const id = setInterval(tick, 2000); return () => { stop = true; clearInterval(id); };
  }, [p.code, state === 'expired']);
  const renew = async () => { try { setError(null); const n = machineId ? await client.rotateMachine(machineId) : await client.createPairing(); setP(n); setState('waiting'); setMachine(null); } catch (e) { setError(fail(e)); } };
  const cmd = p.commands[tab];
  return (
    <section class="card stack" aria-labelledby="pair-h">
      <h2 id="pair-h">{t('machines.pairTitle')}</h2>
      <p>{t('machines.step1')}</p>
      <div class="chips" role="tablist" aria-label={t('machines.pairTitle')}>
        {(['sh', 'powershell', 'node'] as const).map((k) => <button key={k} role="tab" aria-selected={tab === k} class={`chip-btn${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{t(k === 'sh' ? 'machines.tabSh' : k === 'powershell' ? 'machines.tabPs' : 'machines.tabNode')}</button>)}
      </div>
      <pre class="secret" tabIndex={0}>{cmd}</pre>
      <div class="row"><Copy text={cmd} /><Copy text={t('machines.promptText', { cmd })} label={t('machines.prompt')} /></div>
      <p class="muted small">{t('machines.needs')}</p>
      <div class="row between"><span><small class="muted">{t('machines.code')}</small><br /><b class="pairing-code">{p.display}</b></span><small class="muted">{t('machines.expires', { when: until(p.expires) })}</small></div>
      <div class="pair-grid">
        {p.rows && <figure><QrCode rows={p.rows} label={t('machines.qr')} size={168} /><figcaption class="muted small">{t('machines.qr')}</figcaption></figure>}
        <div class="stack"><small class="muted">{t('machines.magic')}</small><pre class="secret small" tabIndex={0}>{p.link}</pre><Copy text={p.link} /></div>
      </div>
      <ErrorLine message={error} />
      <div class="status-line" role="status" aria-live="polite">
        {state === 'waiting' && <span class="shimmer">{t('machines.waiting')}</span>}
        {state === 'paired' && !machine?.profiles.length && <span class="shimmer">{t('machines.paired')}</span>}
        {state === 'paired' && !!machine?.profiles.length && <b>{foundLine(machine)}</b>}
        {state === 'expired' && <span>{t('machines.expired')} <button class="btn text" onClick={renew}>{t('machines.new')}</button></span>}
      </div>
      <p class="muted small">{t('machines.trouble')}</p>
      <TextButton onClick={onClose}>{state === 'paired' ? t('machines.done') : t('machines.cancel')}</TextButton>
    </section>
  );
}
