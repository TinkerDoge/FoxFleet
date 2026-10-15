import { useEffect, useRef, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import type { SavedAgent } from '../lib/registry';
import { AuthRequiredError } from '../api/errors';
import { ErrorLine, Field, PrimaryButton } from '../components/ui';

type Registration = { kind: 'hermes'; connection: 'bot'; name: string; label: string; description: string };
type Attempt = { registration: Registration; inFlight: boolean };
// Non-secret, client-lifetime recovery only; navigation must not forget a possibly persisted write.
const registrations = new WeakMap<Client, Attempt>();
// Only non-secret coordination survives a panel: never retain the minted token or its promise here.
const tokenMutations = new WeakMap<Client, Map<string, { generation: number; inFlight: boolean }>>();

/** Native channel registration never requests Hermes dashboard/API secrets or machine pairing. */
export function NativeBot({ client, saved, onSaved, onClose, onAuthLost }: { client: Client; saved?: SavedAgent; onSaved: () => Promise<void> | void; onClose: () => void; onAuthLost: () => void }) {
  // Hold the attempt itself: it stays reconcilable even after another panel settles and drops the shared entry.
  const [pending, setPending] = useState<Attempt | null>(() => saved ? null : registrations.get(client) ?? null);
  const [name, setName] = useState(saved?.name ?? pending?.registration.name ?? ''), [label, setLabel] = useState(saved?.values.label ?? pending?.registration.label ?? ''), [description, setDescription] = useState(saved?.values.description ?? pending?.registration.description ?? '');
  const [created, setCreated] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(pending ? 'The bot registration may have succeeded: refresh status before trying again.' : null);
  const locked = useRef(false);
  const valid = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name.trim());
  const save = async () => {
    if (locked.current || pending || !valid) return;
    locked.current = true; setBusy(true); setError(null);
    try {
      if (saved) {
        await client.editAgent(saved.name, { label: label.trim(), description: description.trim() });
        await onSaved(); onClose();
      } else {
        const registration: Registration = { kind: 'hermes', connection: 'bot', name: name.trim(), label: label.trim(), description: description.trim() };
        const attempt: Attempt = { registration, inFlight: true };
        registrations.set(client, attempt); setPending(attempt);
        try { await client.addAgent(registration); }
        finally { attempt.inFlight = false; }
        if (registrations.get(client) !== attempt) return;
        registrations.delete(client); setCreated(registration.name); setPending(null); await onSaved();
      }
    } catch (e) {
      if (e instanceof AuthRequiredError) onAuthLost();
      else setError(saved ? 'Could not save the bot. Check the hub connection, then try again.' : 'The bot registration could not be confirmed. It may have succeeded: refresh status before trying again.');
    } finally { locked.current = false; setBusy(false); }
  };
  const reconcile = async () => {
    const attempt = pending;
    if (locked.current || !attempt) return;
    if (attempt.inFlight) { setError('The registration request is still in progress. Refresh status when it finishes.'); return; }
    const want = attempt.registration;
    locked.current = true; setBusy(true); setError(null);
    try {
      const registered = (await client.savedAgents()).find((a) => a.name === want.name);
      // Exact-entry fencing: only ever drop our own attempt, never a newer one another panel started.
      const current = registrations.get(client);
      if (current && current !== attempt) { setPending(current); setError('Another registration is pending. Refresh status before trying again.'); return; }
      const settle = () => { if (registrations.get(client) === attempt) registrations.delete(client); };
      if (!registered) {
        settle(); setPending(null); setError('The bot is not registered. You can retry Create bot.');
      } else if (registered.kind !== want.kind || registered.values.connection !== want.connection || (registered.values.label ?? '') !== want.label || (registered.values.description ?? '') !== want.description) {
        setError('That Bot ID now belongs to a different connection. Registration and token changes are blocked.');
      } else {
        settle(); setCreated(want.name); setPending(null); await onSaved();
      }
    } catch (e) { if (e instanceof AuthRequiredError) onAuthLost(); else setError('Could not refresh registration status. No new registration will be sent until the outcome is confirmed.'); }
    finally { locked.current = false; setBusy(false); }
  };
  if (created) return <BotTokens client={client} name={created} hasToken={false} onChanged={onSaved} onClose={onClose} onAuthLost={onAuthLost} />;
  return <div class="page">
    <header class="page-head"><h1>{saved ? `Edit ${saved.name}` : 'Add native Hermes bot'}</h1><button class="btn text" disabled={busy || Boolean(pending)} onClick={() => { if (!locked.current && !pending) onClose(); }}>Back</button></header>
    <form class="card stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p class="muted">Runs inside your normal Hermes gateway, like Telegram or Discord. No connector, dashboard password or open inbound port.</p>
      {saved ? <p>Bot ID: <code>{saved.name}</code></p> : <Field name="name" label="Bot ID" value={name} onInput={setName} autoComplete="off" hint="Letters, digits, . _ - (up to 64)." />}
      <Field name="label" label="Display name (optional)" value={label} onInput={setLabel} autoComplete="off" />
      <Field name="description" label="Description (optional)" value={description} onInput={setDescription} autoComplete="off" />
      <ErrorLine message={error} />
      {pending && <button type="button" class="btn outline" disabled={busy} onClick={() => void reconcile()}>Refresh registration status</button>}
      <PrimaryButton busy={busy} disabled={!valid || busy || Boolean(pending)}>{saved ? 'Save changes' : 'Create bot'}</PrimaryButton>
    </form>
  </div>;
}

/** The minted secret lives only in this mounted panel. Never put it in URLs, storage, logs or downloads. */
export function BotTokens({ client, name, hasToken, onChanged, onClose, onAuthLost }: { client: Client; name: string; hasToken: boolean; onChanged: () => Promise<void> | void; onClose: () => void; onAuthLost: () => void }) {
  // The list may be stale after a lost write response or a previous panel lifetime.
  const [token, setToken] = useState<string | null>(null), [exists, setExists] = useState(hasToken), [uncertain, setUncertain] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const locked = useRef(false), verifiedGeneration = useRef<number | null>(null);
  const [mutation] = useState(() => {
    let bots = tokenMutations.get(client);
    if (!bots) { bots = new Map(); tokenMutations.set(client, bots); }
    let state = bots.get(name);
    if (!state) { state = { generation: 0, inFlight: false }; bots.set(name, state); }
    return state;
  });
  const change = async (revoke: boolean) => {
    if (locked.current || uncertain || mutation.inFlight || verifiedGeneration.current !== mutation.generation) return;
    if ((revoke || exists) && !confirm(revoke ? 'Revoke this bot token? The Hermes channel will disconnect until you create and configure a new token.' : 'Rotate this bot token? The old token stops working immediately and the connected Hermes channel will disconnect.')) return;
    mutation.inFlight = true; mutation.generation++;
    locked.current = true; setBusy(true); setError(null); setNotice(null); setToken(null);
    try {
      if (revoke) { await client.revokeBotToken(name); setExists(false); setNotice('Token revoked'); }
      else { const result = await client.mintBotToken(name); setToken(result.token); setExists(true); }
      verifiedGeneration.current = mutation.generation;
      await onChanged();
    } catch (e) {
      verifiedGeneration.current = null;
      if (e instanceof AuthRequiredError) onAuthLost();
      else { setUncertain(true); setError('The token change could not be confirmed. It may have succeeded: refresh before trying again.'); }
    } finally { mutation.inFlight = false; locked.current = false; setBusy(false); }
  };
  const refreshStatus = async () => {
    if (locked.current) return;
    setUncertain(true); verifiedGeneration.current = null;
    if (mutation.inFlight) { setError('A token change is still in progress. Refresh status when it finishes.'); return; }
    const generation = mutation.generation;
    locked.current = true; setBusy(true);
    try {
      const saved = (await client.savedAgents()).find((a) => a.name === name);
      if (mutation.inFlight || mutation.generation !== generation) { setError('The token changed while status was loading. Refresh status before trying again.'); return; }
      if (!saved || saved.kind !== 'hermes' || saved.values.connection !== 'bot') { setError('This bot is no longer registered or has been replaced. Return to the agent list.'); return; }
      verifiedGeneration.current = mutation.generation;
      setExists(saved.saved.includes('botToken')); setUncertain(false); setError(null);
    } catch (e) { if (e instanceof AuthRequiredError) onAuthLost(); else setError('Could not refresh token status. Try again when the hub is reachable.'); }
    finally { locked.current = false; setBusy(false); }
  };
  useEffect(() => { void refreshStatus(); }, []);
  const copy = async () => {
    if (!token) return;
    try { await navigator.clipboard.writeText(token); setNotice('Token copied. Keep it private.'); }
    catch { setNotice('Clipboard unavailable. Select and copy the token below.'); }
  };
  const close = () => { setToken(null); onClose(); };
  return <div class="page">
    <header class="page-head"><h1>{name}: bot token</h1><button class="btn text" disabled={busy} onClick={close}>Done</button></header>
    <section class="card stack">
      <p>One token per Hermes profile. Store it as <code>FOXFLEET_BOT_TOKEN</code> in that profile's private <code>.env</code>, never in a shared repository.</p>
      <p class="muted">Configure the hub URL with <code>hermes config set foxfleet.hub_url https://your-hub</code>, install the FoxFleet platform plugin, and allow your hub user ID. Restart the profile's normal gateway when ready.</p>
      <p class="warn">Tokens are shown only once. Rotating or revoking disconnects the current bot. Leaving this page forgets the displayed token.</p>
      {token && <div class="field"><label for="bot-token">New bot token</label><input id="bot-token" name="bot-token" type="text" autoComplete="off" spellcheck={false} readOnly value={token} /><button class="btn outline" onClick={() => void copy()}>Copy token</button></div>}
      <ErrorLine message={error} />
      {notice && <p role="status">{notice}</p>}
      {uncertain && <button class="btn outline" disabled={busy} onClick={() => void refreshStatus()}>Refresh token status</button>}
      <div class="row between">
        <button class="btn primary" disabled={busy || uncertain} onClick={() => void change(false)}>{exists ? 'Rotate bot token' : 'Create bot token'}</button>
        {exists && <button class="btn text danger" disabled={busy || uncertain} onClick={() => void change(true)}>Revoke bot token</button>}
      </div>
    </section>
  </div>;
}
