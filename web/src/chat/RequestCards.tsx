import { useRef, useState } from 'preact/hooks';
import type { OpenRequest } from '../api/client';
import { t } from '../i18n/t';

/** One card per question or approval the agent is waiting on. Answering sends exactly one reply for that id; the card disappears when the hub confirms (or says it is already closed). */
export function RequestCards({ requests, agent, onAnswer }: { requests: OpenRequest[]; agent: string; onAnswer: (id: string, result: Record<string, unknown>) => Promise<string | null> }) {
  if (!requests.length) return null;
  return <div class="requests" role="region" aria-label={t('req.clarify', { agent })}>{requests.map((r) => <Card key={r.id} r={r} agent={agent} onAnswer={onAnswer} />)}</div>;
}
function Card({ r, agent, onAnswer }: { r: OpenRequest; agent: string; onAnswer: (id: string, result: Record<string, unknown>) => Promise<string | null> }) {
  const [busy, setBusy] = useState(false), [err, setErr] = useState(''), [picked, setPicked] = useState<Record<string, string[]>>({}), [typed, setTyped] = useState<Record<string, string>>({});
  const sending = useRef(false); // a ref: two clicks in the same tick must still send one answer
  const go = async (result: Record<string, unknown>) => { if (sending.current) return; sending.current = true; setBusy(true); setErr(''); const e = await onAnswer(r.id, result); if (e) { setErr(e); setBusy(false); sending.current = false; } };
  if (r.kind === 'approval') {
    return (
      <div class="card request approval" role="group" aria-label={t('req.approval', { agent })}>
        <b>{t('req.approval', { agent })}</b>
        {r.description && <p>{r.description}</p>}
        {r.command && <><small class="muted">{t('req.command')}</small><pre class="cmd">{r.command}</pre></>}
        <div class="row"><button class="btn" disabled={busy} onClick={() => void go({ choice: 'once' })}>{t('req.allowOnce')}</button><button class="btn text" disabled={busy} onClick={() => void go({ choice: 'deny' })}>{t('req.deny')}</button></div>
        {err && <p class="error" role="alert">{t('req.failed', { error: err })}</p>}
      </div>
    );
  }
  const answers = () => Object.fromEntries(r.questions.map((q) => { const v = (typed[q.id] ?? '').trim(); return [q.id, v || (q.multi ? (picked[q.id] ?? []).join(', ') : (picked[q.id] ?? [])[0] ?? '')]; }));
  return (
    <div class="card request clarify" role="group" aria-label={t('req.clarify', { agent })}>
      <b>{t('req.clarify', { agent })}</b>
      {r.questions.length === 0 && <p class="muted">{t('req.noQuestion')}</p>}
      {r.questions.map((q) => (
        <fieldset key={q.id} disabled={busy}>
          <legend>{q.question}</legend>
          {q.choices.map((c) => (
            <label key={c} class="choice"><input type={q.multi ? 'checkbox' : 'radio'} name={`${r.id}-${q.id}`} checked={(picked[q.id] ?? []).includes(c)}
              onChange={() => setPicked((p) => ({ ...p, [q.id]: q.multi ? ((p[q.id] ?? []).includes(c) ? (p[q.id] ?? []).filter((x) => x !== c) : [...(p[q.id] ?? []), c]) : [c] }))} /> {c}</label>
          ))}
          <input type="text" class="other" placeholder={q.choices.length ? t('req.other') : ''} aria-label={q.question} value={typed[q.id] ?? ''} onInput={(e) => setTyped((p) => ({ ...p, [q.id]: (e.currentTarget as HTMLInputElement).value }))} />
        </fieldset>
      ))}
      <div class="row"><button class="btn" disabled={busy} onClick={() => void go({ answers: answers() })}>{t('req.send')}</button></div>
      {err && <p class="error" role="alert">{t('req.failed', { error: err })}</p>}
    </div>
  );
}
