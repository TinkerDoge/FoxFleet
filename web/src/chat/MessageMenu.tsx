import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '../components/Icon';
import type { IconName } from '../icons/paths';
import { t, type Key } from '../i18n/t';
import { Emoji, EmojiPicker } from './Reactions';
import { QUICK, type MessageAction } from './messageActions';

// `select` is never offered on web (Task 8 passes `selectable: false`); its entries only satisfy the type.
const LABEL: Record<MessageAction, Key> = { reply: 'msg.reply', copy: 'msg.copy', select: 'msg.copy', share: 'msg.share', retry: 'msg.retry', edit: 'msg.edit', delete: 'msg.delete' };
const ICON: Record<MessageAction, IconName> = { reply: 'reply', copy: 'copy', select: 'selectAll', share: 'share', retry: 'retry', edit: 'edit', delete: 'delete' };
const NAV = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];

const MARGIN = 8;
/** Keeps a box of `size` inside `[0, view]` with a margin; a box too big for the view sits at the margin. */
export const clampToView = (at: number, size: number, view: number) => (size > view - 2 * MARGIN ? MARGIN : Math.max(MARGIN, Math.min(at, view - MARGIN - size)));

/** Long-press / right-click menu for one message: quick reactions on top, then the actions. Escape, an outside press or focus leaving closes it. */
export function MessageMenu({ id, x, y, actions, canReact, onReact, onAction, onClose }: {
  id?: string; x: number; y: number; actions: MessageAction[]; canReact: boolean;
  onReact: (emoji: string) => void; onAction: (a: MessageAction) => void; onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null), [picking, setPicking] = useState(false);
  const close = useRef(onClose); close.current = onClose;
  // Placed by its real size (the picker is wider and taller than the list), clamped to the viewport before the first paint.
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect(); if (!r) return;
    const left = clampToView(x, r.width, innerWidth), top = clampToView(y, r.height, innerHeight);
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
  }, [picking, x, y]);
  useLayoutEffect(() => {
    if (picking) return; // the picker owns focus, Escape and outside presses while it is open
    box.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (e: Event) => { if (!box.current?.contains(e.target as Node)) close.current(); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); document.removeEventListener('keydown', escape); };
  }, [picking]);
  // Arrows walk the quick row (left/right) and the items (up/down), wrapping; Home/End jump to the ends of the items.
  function keys(e: KeyboardEvent) {
    if (!NAV.includes(e.key) || !box.current) return;
    const row = e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? '.msg-menu-quick button' : '[role=menuitem]';
    const list = [...box.current.querySelectorAll<HTMLButtonElement>(row)];
    if (!list.length) return;
    e.preventDefault();
    const i = list.indexOf(document.activeElement as HTMLButtonElement), step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    list[e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : i < 0 ? 0 : (i + step + list.length) % list.length]?.focus();
  }
  return (
    <div class="msg-menu" id={id} ref={box} style={{ left: `${pos.left}px`, top: `${pos.top}px` }} onKeyDown={picking ? undefined : keys}>
      {picking ? <EmojiPicker onPick={(e) => onReact(e)} onClose={onClose} /> : <>
        {canReact && <div class="msg-menu-quick" role="group" aria-label={t('react.add')}>
          {QUICK.map((e) => <button type="button" key={e} aria-label={t('msg.react', { emoji: e })} onClick={() => onReact(e)}><Emoji value={e} size={24} /></button>)}
          <button type="button" class="more" aria-label={t('msg.moreReactions')} title={t('msg.moreReactions')} onClick={() => setPicking(true)}><Icon name="react" size={22} /></button>
        </div>}
        <div role="menu" aria-label={t('msg.actions')}>
          {actions.map((a) => <button type="button" role="menuitem" key={a} class={a === 'delete' ? 'danger' : undefined} onClick={() => onAction(a)}><Icon name={ICON[a]} size={20} /><span>{t(LABEL[a])}</span></button>)}
        </div>
      </>}
    </div>
  );
}
