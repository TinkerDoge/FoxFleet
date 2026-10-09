import type { ComponentChildren } from 'preact';
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';

/** Small action menus share the History menu's keyboard and dismissal model. */
export function ActionMenu({ label, children, actions, className = '', above = false }: {
  label: string; children: ComponentChildren; className?: string; above?: boolean;
  actions: { label: string; onSelect: () => void }[];
}) {
  const [open, setOpen] = useState(false), id = useId();
  const anchor = useRef<HTMLSpanElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]');
    items?.[first.current ? 0 : items.length - 1]?.focus();
    const outside = (e: Event) => { if (!anchor.current?.contains(e.target as Node)) close(); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <span class={`action-anchor ${className}`} ref={anchor}>
    <button type="button" class="icon-btn" ref={trigger} id={`${id}-action-toggle`} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={`${id}-actions`}
      onClick={() => { first.current = true; setOpen(!open); }}
      onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); first.current = e.key === 'ArrowDown'; setOpen(true); } }}>{children}</button>
    {open && <div class={`action-menu${above ? ' above' : ''}`} id={`${id}-actions`} ref={menu} role="menu" aria-labelledby={`${id}-action-toggle`}
      onKeyDown={(e) => {
        if (e.key === 'Tab') { close(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault(); const items = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role=menuitem]')], current = items.indexOf(document.activeElement as HTMLButtonElement);
        items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }}>
      {actions.map((action) => <button type="button" key={action.label} role="menuitem" tabIndex={-1} onClick={() => { close(true); action.onSelect(); }}>{action.label}</button>)}
    </div>}
  </span>;
}
