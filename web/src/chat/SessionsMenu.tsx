import { useLayoutEffect, useId, useRef, useState } from 'preact/hooks';
import type { SessionInfo } from '../api/types';
import { ago } from '../lib/time';
import { t } from '../i18n/t';

/**
 * The single history UI: a keyboard-navigable menu of earlier sessions. Rows show title, time and preview.
 * The optional handlers add what the hub's history API supports: New chat, refresh, load more, rename, delete.
 * Without them it is the plain list (every menu item is then exactly one session).
 */
export function SessionsMenu({ sessions, current, open, onOpenChange, onSelect, total, loading, error, onNew, onRefresh, onLoadMore, onRename, onDelete }: {
  sessions: SessionInfo[]; current?: string; open: boolean;
  onOpenChange: (open: boolean) => void; onSelect: (id: string) => void;
  total?: number; loading?: boolean; error?: string;
  onNew?: () => void; onRefresh?: () => void; onLoadMore?: () => void;
  onRename?: (id: string, title: string) => Promise<unknown> | void; onDelete?: (id: string) => Promise<unknown> | void;
}) {
  const [editing, setEditing] = useState<string | null>(null), [title, setTitle] = useState('');
  const id = useId(), anchor = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const initial = useRef<'first' | 'last' | 'current'>('current');
  const close = (restore = false) => { onOpenChange(false); if (restore) trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    const index = initial.current === 'last' ? (items?.length ?? 0) - 1 : initial.current === 'first' ? 0 : Math.max(0, Array.from(items ?? []).findIndex((el) => el.dataset.sid === current));
    (items?.[index] ?? menu.current)?.focus();
    const outside = (e: Event) => { if (!anchor.current?.contains(e.target as Node)) close(); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(true); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  function navigate(e: KeyboardEvent) {
    if (e.key === 'Tab') { close(); return; }
    if ((e.target as HTMLElement).tagName === 'INPUT') return; // typing a new title: arrows and Home/End belong to the field
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (!items.length) return;
    const focused = items.findIndex((el) => el === document.activeElement);
    const index = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (focused + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[index].focus();
  }
  return (
    <div class="sessions-anchor" ref={anchor}>
      <button class="btn text" ref={trigger} id={`${id}-trigger`} aria-haspopup="menu" aria-expanded={open} aria-controls={`${id}-menu`}
        onClick={() => { initial.current = 'current'; onOpenChange(!open); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); initial.current = e.key === 'ArrowDown' ? 'first' : 'last'; onOpenChange(true); }
        }}>{t('chat.history')}</button>
      {open && (
        <div class="sessions card" ref={menu} id={`${id}-menu`} role="menu" aria-labelledby={`${id}-trigger`} tabIndex={-1} onKeyDown={navigate}>
          {error && <p class="error small" role="alert">{error}</p>}
          {sessions.length === 0 && !loading && <p class="muted small">{t('chat.noSessions')}</p>}
          {sessions.map((s) => editing === s.id ? (
            <form key={s.id} class="session-edit" onSubmit={(e) => { e.preventDefault(); const v = title.trim(); if (!v) return; setEditing(null); void onRename?.(s.id, v); }}>
              <input value={title} maxLength={120} aria-label={t('chat.rename')} autofocus onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); } }} />
              <button type="submit" role="menuitem" tabIndex={-1}>{t('common.save')}</button>
            </form>
          ) : (
            <div key={s.id} class={`session-row${s.id === current ? ' on' : ''}`} role="none">
              <button role="menuitem" tabIndex={-1} data-sid={s.id} aria-current={s.id === current ? 'true' : undefined} class={`session-open${s.id === current ? ' on' : ''}`}
                onClick={() => { close(true); onSelect(s.id); }}>
                <span class="session-title">{s.title || s.id}</span>
                {(s.updated || s.messages) ? <small class="muted">{s.updated ? ago(s.updated) : ''}{s.messages ? `${s.updated ? ' · ' : ''}${s.messages}` : ''}</small> : null}
                {s.preview && <span class="session-preview muted">{s.preview}</span>}
              </button>
              {(onRename || onDelete) && <span class="session-actions" role="none">
                {onRename && <button role="menuitem" tabIndex={-1} aria-label={`${t('chat.rename')}: ${s.title || s.id}`} onClick={() => { setTitle(s.title ?? ''); setEditing(s.id); }}>✎</button>}
                {onDelete && <button role="menuitem" tabIndex={-1} aria-label={`${t('chat.delete')}: ${s.title || s.id}`} onClick={() => { if (confirm(t('chat.deleteConfirm'))) void onDelete(s.id); }}>🗑</button>}
              </span>}
            </div>
          ))}
          {(onNew || onRefresh || (onLoadMore && sessions.length < (total ?? 0))) && <div class="session-foot" role="none">
            {onNew && <button role="menuitem" tabIndex={-1} onClick={() => { close(true); onNew(); }}>{t('chat.new')}</button>}
            {onLoadMore && sessions.length < (total ?? 0) && <button role="menuitem" tabIndex={-1} disabled={loading} onClick={onLoadMore}>{loading ? t('home.loading') : t('chat.loadMore')}</button>}
            {onRefresh && <button role="menuitem" tabIndex={-1} disabled={loading} aria-label={t('chat.refresh')} onClick={onRefresh}>↻</button>}
          </div>}
        </div>
      )}
    </div>
  );
}
