import { useEffect, useRef, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import { deleteSession, loadSessions, newChat, openSession, renameSession, useChat } from './store';
import { ago } from '../lib/time';
import { t } from '../i18n/t';

/** History: earlier conversations of this agent (title, time, preview), open one, rename, delete, load more, refresh. */
export function Sessions({ client, agent, onClose, onAuthLost }: { client: Client; agent: string; onClose: () => void; onAuthLost: () => void }) {
  const c = useChat(agent), [editing, setEditing] = useState<string | null>(null), [draft, setDraft] = useState(''), [err, setErr] = useState(''), box = useRef<HTMLDivElement>(null);
  useEffect(() => { void loadSessions(client, agent, false, onAuthLost); box.current?.focus(); }, [agent]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
  const fail = () => setErr(t('chat.historyFailed'));
  return (
    <div class="sessions card" role="dialog" aria-label={t('chat.history')} ref={box} tabIndex={-1}>
      <div class="sessions-head">
        <b>{t('chat.history')}</b>
        <button class="btn text" onClick={() => { newChat(agent); onClose(); }}>{t('chat.new')}</button>
        <button class="btn text" aria-label={t('chat.refresh')} disabled={c.sessionsLoading} onClick={() => void loadSessions(client, agent, false, onAuthLost)}>↻</button>
        <button class="btn text" aria-label={t('common.close')} onClick={onClose}>✕</button>
      </div>
      {err && <p class="error small" role="alert">{err}</p>}
      {c.sessions.length === 0 && !c.sessionsLoading && <p class="muted small">{t('chat.noSessions')}</p>}
      <ul class="session-list">
        {c.sessions.map((s) => (
          <li key={s.id} class={s.id === c.session ? 'on' : ''}>
            {editing === s.id ? (
              <form onSubmit={(e) => { e.preventDefault(); const v = draft.trim(); if (!v) return; setEditing(null); renameSession(client, agent, s.id, v).catch(fail); }}>
                <input value={draft} maxLength={120} aria-label={t('chat.rename')} autofocus onInput={(e) => setDraft((e.target as HTMLInputElement).value)} />
                <button class="btn text" type="submit">{t('common.save')}</button>
              </form>
            ) : (
              <>
                <button class="session-open" onClick={() => { onClose(); void openSession(client, agent, s.id, onAuthLost); }} aria-current={s.id === c.session ? 'true' : undefined}>
                  <span class="session-title">{s.title || t('chat.untitled')}</span>
                  <small class="muted">{ago(s.updated)}{s.messages ? ` · ${s.messages}` : ''}</small>
                  {s.preview && <span class="session-preview muted">{s.preview}</span>}
                </button>
                <span class="session-actions">
                  <button class="btn text" aria-label={t('chat.rename')} onClick={() => { setDraft(s.title ?? ''); setEditing(s.id); }}>✎</button>
                  <button class="btn text" aria-label={t('chat.delete')} onClick={() => { if (confirm(t('chat.deleteConfirm'))) deleteSession(client, agent, s.id).catch(fail); }}>🗑</button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      {c.sessions.length < c.sessionsTotal && <button class="btn" disabled={c.sessionsLoading} onClick={() => void loadSessions(client, agent, true, onAuthLost)}>{t('chat.loadMore')}</button>}
      {c.sessionsLoading && <p class="muted small center">{t('home.loading')}</p>}
    </div>
  );
}
