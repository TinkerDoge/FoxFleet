import { useEffect, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import { ApiError, AuthRequiredError, NetworkError } from '../api/errors';
import { ErrorLine, Field, PrimaryButton, TextButton } from '../components/ui';
import { CHECK_LABELS, isEnum, isSecret, moved, payload, scrubAddresses, validate, visible, type AgentKind, type Form, type KindField, type SavedAgent, type TestResult } from '../lib/registry';
import { t } from '../i18n/t';
import { Machines } from './Machines';

const fail = (e: unknown) => (e instanceof NetworkError ? t('error.network') : e instanceof ApiError ? scrubAddresses(e.message) : t('error.generic'));

/** Owner screen: saved agents with reorder / edit / remove, and the add flow. */
export function Manage({ client, onChanged, onAuthLost }: { client: Client; onChanged: () => void; onAuthLost: () => void }) {
  const [list, setList] = useState<SavedAgent[] | null>(null), [kinds, setKinds] = useState<AgentKind[]>([]), [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ saved?: SavedAgent; kind?: AgentKind } | null>(null);
  const guard = async (fn: () => Promise<void>) => { try { setError(null); await fn(); } catch (e) { if (e instanceof AuthRequiredError) onAuthLost(); else setError(fail(e)); } };
  const load = () => guard(async () => { const [l, k] = await Promise.all([client.savedAgents(), client.agentKinds()]); setList(l); setKinds(k); });
  useEffect(() => { void load(); }, []);
  const refresh = () => { onChanged(); return load(); };
  if (editing) return <Editor client={client} kinds={kinds} initial={editing} onClose={() => setEditing(null)} onSaved={refresh} onAuthLost={onAuthLost} />;
  const move = (i: number, d: number) => list && guard(async () => { const next = moved(list, i, d); setList(next); await client.reorderAgents(next.map((a) => a.name)); onChanged(); });
  const remove = (a: SavedAgent) => { if (confirm(t('manage.confirmRemove', { name: a.name }))) void guard(async () => { await client.deleteAgent(a.name); await refresh(); }); };
  return (
    <div class="page">
      <header class="page-head"><h1>{t('manage.title')}</h1><button class="btn primary inline" onClick={() => setEditing({})}>{t('manage.add')}</button></header>
      <ErrorLine message={error} />
      <Machines client={client} onChanged={refresh} onAuthLost={onAuthLost} />
      {list === null && !error && <p class="muted">{t('home.loading')}</p>}
      {list?.length === 0 && <div class="card"><p class="muted">{t('manage.empty')}</p></div>}
      {list && list.length > 0 && (
        <ul class="card list">
          {list.map((a, i) => (
            <li key={a.name} class="static">
              <span class="grow"><b>{a.values.label || a.name}</b><small class="muted">{kinds.find((k) => k.kind === a.kind)?.label ?? a.kind}</small></span>
              <button class="icon-btn" aria-label={t('manage.moveUp')} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button class="icon-btn" aria-label={t('manage.moveDown')} disabled={i === list.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button class="btn text" onClick={() => setEditing({ saved: a, kind: kinds.find((k) => k.kind === a.kind) })}>{t('manage.edit')}</button>
              {a.values.connection === 'machine' ? <small class="muted">{t('manage.fromMachine')}</small> : <button class="btn text danger" onClick={() => remove(a)}>{t('manage.remove')}</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Editor({ client, kinds, initial, onClose, onSaved, onAuthLost }: { client: Client; kinds: AgentKind[]; initial: { saved?: SavedAgent; kind?: AgentKind }; onClose: () => void; onSaved: () => Promise<void> | void; onAuthLost: () => void }) {
  const saved = initial.saved; const editing = Boolean(saved);
  const [kind, setKind] = useState<AgentKind | undefined>(initial.kind);
  const [form, setForm] = useState<Form>(() => ({ ...(saved?.values ?? {}) }));
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState<'test' | 'save' | 'token' | null>(null), [test, setTest] = useState<TestResult | null>(null);
  const [secret, setSecret] = useState<{ title: string; text: string } | null>(null), [copied, setCopied] = useState(false);
  if (!kind) {
    return (
      <div class="page"><header class="page-head"><h1>{t('manage.pickType')}</h1><TextButton onClick={onClose}>{t('manage.back')}</TextButton></header>
        <ul class="card list">{kinds.filter((k) => !k.planned).map((k) => <li key={k.kind} tabIndex={0} onClick={() => setKind(k)} onKeyDown={(e) => e.key === 'Enter' && setKind(k)}><span class="grow"><b>{k.label}</b><small class="muted">{k.summary}</small></span><span aria-hidden="true">›</span></li>)}</ul>
      </div>
    );
  }
  const set = (key: string, v: string) => { setForm((f) => ({ ...f, [key]: v })); setTest(null); };
  const fields = kind.fields.filter((f) => visible(f, form, kind));
  const problem = validate(kind, form, editing, saved);
  const guard = async (which: 'test' | 'save' | 'token', fn: () => Promise<void>) => { setBusy(which); setError(null); try { await fn(); } catch (e) { if (e instanceof AuthRequiredError) onAuthLost(); else setError(fail(e)); } finally { setBusy(null); } };
  const body = () => ({ ...payload(kind, form, editing), ...(editing ? { name: saved!.name, kind: kind.kind } : {}) });
  const doTest = () => guard('test', async () => setTest(await client.testAgent(body())));
  const doSave = () => guard('save', async () => {
    const r = editing ? await client.editAgent(saved!.name, payload(kind, form, true)) : await client.addAgent(payload(kind, form, false));
    await onSaved();
    if (r.inboxToken) setSecret({ title: t('manage.inboxTitle'), text: r.inboxToken });
    else onClose();
  });
  const newToken = () => guard('token', async () => { const r = await client.newToken(saved!.name); if (r.inboxToken) setSecret({ title: t('manage.inboxTitle'), text: r.inboxToken }); });
  if (secret) {
    return (
      <div class="page"><header class="page-head"><h1>{secret.title}</h1></header>
        <div class="card stack"><p class="muted">{t('manage.bootstrapBody')}</p><pre class="secret" tabIndex={0}>{secret.text}</pre>
          <button class="btn primary" onClick={() => { void navigator.clipboard?.writeText(secret.text); setCopied(true); }}>{copied ? t('chat.copied') : t('manage.copy')}</button>
          <TextButton onClick={() => { setSecret(null); onClose(); }}>{t('manage.done')}</TextButton></div>
      </div>
    );
  }
  const basic = fields.filter((f) => !f.advanced), adv = fields.filter((f) => f.advanced);
  const render = (f: KindField) => <FieldInput key={f.key} f={f} value={form[f.key] ?? f.default ?? ''} savedSecret={saved?.saved.includes(f.key) ?? false} editing={editing} onInput={(v) => set(f.key, v)} />;
  return (
    <div class="page">
      <header class="page-head"><h1>{editing ? saved!.name : kind.label}</h1><TextButton onClick={onClose}>{t('manage.back')}</TextButton></header>
      <form class="card stack" onSubmit={(e) => { e.preventDefault(); if (!problem) void doSave(); }}>
        <p class="muted">{kind.summary}</p>
        {kind.warnings.map((w) => <p class="warn" key={w}>{w}</p>)}
        {basic.map(render)}
        {adv.length > 0 && <details class="advanced"><summary>{t('manage.advanced')}</summary><div class="stack">{adv.map(render)}</div></details>}
        <ErrorLine message={error} />
        {test && <ul class="checks" role="status">{test.checks.map(([k, c]) => <li key={k} class={c.ok ? 'ok' : 'bad'}><b>{CHECK_LABELS[k] ?? k}</b><span>{c.ok ? 'OK' : c.message || 'Failed'}</span></li>)}{test.checks.length === 0 && <li class={test.ok ? 'ok' : 'bad'}><b>Connection</b><span>{test.ok ? 'OK' : 'Failed'}</span></li>}</ul>}
        <div class="row between">
          <button type="button" class="btn outline" disabled={Boolean(problem) || busy !== null} onClick={doTest}>{busy === 'test' ? t('manage.testing') : t('manage.test')}</button>
          <PrimaryButton busy={busy === 'save'} disabled={Boolean(problem) || busy !== null}>{busy === 'save' ? t('manage.saving') : t('manage.save')}</PrimaryButton>
        </div>
        {problem && <p class="muted small">{problem}</p>}
        {editing && kind.kind === 'mcp-inbox' && <TextButton onClick={newToken}>{t('manage.newToken')}</TextButton>}
      </form>
    </div>
  );
}

function FieldInput({ f, value, savedSecret, editing, onInput }: { f: KindField; value: string; savedSecret: boolean; editing: boolean; onInput: (v: string) => void }) {
  const label = f.label + (f.required && !(editing && savedSecret) ? '' : '');
  if (isEnum(f)) {
    return (
      <fieldset class="field enum"><legend>{label}</legend>
        <div class="chips" role="radiogroup" aria-label={f.label}>{f.options.map((o) => <button type="button" role="radio" aria-checked={value === o} class={`chip-btn${value === o ? ' on' : ''}`} key={o} onClick={() => onInput(o)}>{o}</button>)}</div>
        {f.help && <small>{f.help}</small>}
      </fieldset>
    );
  }
  const secret = isSecret(f) || f.writeOnly;
  const hint = secret && editing && savedSecret ? t('manage.saved') : f.help;
  return <Field label={label} name={f.key} value={value} onInput={onInput} hint={hint} type={isSecret(f) ? 'password' : f.type === 'port' ? 'number' : 'text'} autoComplete="off" />;
}
