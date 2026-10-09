import { useLayoutEffect, useId, useRef } from 'preact/hooks';
import type { SessionInfo } from '../api/types';
import { t } from '../i18n/t';

export function SessionsMenu({ sessions, current, open, onOpenChange, onSelect }: {
  sessions: SessionInfo[]; current?: string; open: boolean;
  onOpenChange: (open: boolean) => void; onSelect: (id: string) => void;
}) {
  const id = useId(), anchor = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const initial = useRef<'first' | 'last' | 'current'>('current');
  const close = (restore = false) => { onOpenChange(false); if (restore) trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    const index = initial.current === 'last' ? (items?.length ?? 0) - 1 : initial.current === 'first' ? 0 : Math.max(0, sessions.findIndex((s) => s.id === current));
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
  }, [open, sessions]);
  function navigate(e: KeyboardEvent) {
    if (e.key === 'Tab') { close(); return; }
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
        }}>{t('chat.sessions')}</button>
      {open && (
        <div class="sessions card" ref={menu} id={`${id}-menu`} role="menu" aria-labelledby={`${id}-trigger`} tabIndex={-1} onKeyDown={navigate}>
          {sessions.length === 0 && <p class="muted small">{t('chat.noSessions')}</p>}
          {sessions.map((s) => <button key={s.id} role="menuitem" tabIndex={-1} aria-current={s.id === current ? 'true' : undefined} class={s.id === current ? 'on' : ''}
            onClick={() => { close(true); onSelect(s.id); }}>{s.title || s.id}</button>)}
        </div>
      )}
    </div>
  );
}
