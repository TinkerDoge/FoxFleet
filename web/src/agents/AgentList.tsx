import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AgentSummary } from '../api/types';
import { Icon } from '../components/Icon';
import { avatarSeed, isUnread, listTime, previewLine, sortAgents } from '../lib/agentList';
import { chatOf } from '../chat/store';
import { t } from '../i18n/t';

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Animates rows from where they were to where they are now (FLIP) when the order changes. transform only, 200ms ease-out. */
function useFlip(host: { current: HTMLElement | null }, order: string) {
  const last = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const el = host.current; if (!el) return;
    const next = new Map<string, number>();
    el.querySelectorAll<HTMLElement>('[data-key]').forEach((row) => {
      const key = row.dataset.key!, top = row.offsetTop; next.set(key, top);
      const was = last.current.get(key);
      if (was !== undefined && was !== top && !reduced() && row.animate) row.animate([{ transform: `translateY(${was - top}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    });
    last.current = next;
  }, [order]);
}

export function Avatar({ a, size = 48 }: { a: Pick<AgentSummary, 'name' | 'displayName' | 'avatar' | 'online'>; size?: number }) {
  const { initials, hue } = avatarSeed(a.name, a.displayName), emoji = a.avatar && /\P{ASCII}/u.test(a.avatar) && [...a.avatar].length <= 4 ? a.avatar : null;
  return <span class="avatar" style={{ width: size, height: size, '--hue': hue, fontSize: size * 0.38 } as any} aria-hidden="true">
    <span class="avatar-face">{emoji ?? initials}</span><span class={`presence ${a.online ? 'on' : 'off'}`} />
  </span>;
}

function Row({ a, selected, onPick, onMenu, onPin }: { a: AgentSummary; selected: boolean; onPick: () => void; onMenu: (e: { x: number; y: number }, a: AgentSummary) => void; onPin: (a: AgentSummary) => void }) {
  const running = chatOf(a.name).streaming, p = previewLine(a, running), unread = isUnread(a, selected), name = a.displayName || a.name;
  const press = useRef<number>(); const cancel = () => { clearTimeout(press.current); };
  return (
    <li class={`agent-row${selected ? ' active' : ''}${a.pinned ? ' pinned' : ''}${unread ? ' unread' : ''}`} data-key={a.name}>
      <a href={`#/chat?agent=${encodeURIComponent(a.name)}`} aria-current={selected ? 'page' : undefined} onClick={onPick}
        onContextMenu={(e) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }, a); }}
        onTouchStart={(e) => { const tch = e.touches[0]; press.current = window.setTimeout(() => onMenu({ x: tch.clientX, y: tch.clientY }, a), 520); }} onTouchEnd={cancel} onTouchMove={cancel} onTouchCancel={cancel}>
        <Avatar a={a} />
        <span class="row-body">
          <span class="row-top"><span class="row-name">{name}</span>{a.pinned && <Icon name="pin" size={14} class="row-pin-mark" />}<time class="row-time">{listTime(a.last_activity_at)}</time></span>
          <span class="row-bottom">
            <span class={`row-preview ${p.kind}`}>
              {p.kind === 'typing' && <><span class="typing-label">{t('list.typing')}</span><span class="typing-dots" aria-hidden="true"><i /><i /><i /></span></>}
              {p.kind === 'approval' && t('list.needsApproval')}
              {p.kind === 'text' && <>{p.you && <span class="you">{t('list.you')}</span>}{p.text}</>}
              {p.kind === 'empty' && (p.text || t('list.noMessages'))}
            </span>
            {unread && <span class="badge" role="img" aria-label={t('list.unread')} />}
          </span>
        </span>
      </a>
      <button type="button" class="row-pin icon-btn small" aria-label={t(a.pinned ? 'list.unpinNamed' : 'list.pinNamed', { name })} aria-pressed={Boolean(a.pinned)} onClick={() => onPin(a)}><Icon name={a.pinned ? 'unpin' : 'pin'} size={16} /></button>
    </li>
  );
}

export function AgentList({ agents, selectedName, onPick, onPin }: { agents: AgentSummary[] | null; selectedName?: string; onPick: () => void; onPin: (a: AgentSummary) => void }) {
  const [q, setQ] = useState(''), [menu, setMenu] = useState<{ x: number; y: number; a: AgentSummary } | null>(null), [, tick] = useState(0);
  const host = useRef<HTMLUListElement>(null), menuEl = useRef<HTMLDivElement>(null);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 60_000); return () => clearInterval(id); }, []);
  const sorted = useMemo(() => sortAgents(agents ?? []), [agents]);
  const needle = q.trim().toLowerCase(), shown = needle ? sorted.filter((a) => `${a.displayName ?? ''} ${a.name} ${a.last_message_preview ?? ''}`.toLowerCase().includes(needle)) : sorted;
  useFlip(host, shown.map((a) => a.name).join('|'));
  useLayoutEffect(() => {
    if (!menu) return; menuEl.current?.querySelector<HTMLElement>('button')?.focus();
    const away = (e: Event) => { if (!menuEl.current?.contains(e.target as Node)) setMenu(null); }, key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(null); } };
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', key, true); return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key, true); };
  }, [menu]);
  const pinned = shown.filter((a) => a.pinned), rest = shown.filter((a) => !a.pinned);
  const rows = (list: AgentSummary[]) => list.map((a) => <Row key={a.name} a={a} selected={selectedName === a.name} onPick={onPick} onMenu={(pos, x) => setMenu({ ...pos, a: x })} onPin={onPin} />);
  return (
    <div class="agent-list">
      <label class="search"><Icon name="search" size={18} /><input type="search" value={q} placeholder={t('list.search')} aria-label={t('list.search')} onInput={(e) => setQ((e.target as HTMLInputElement).value)} /></label>
      {agents === null && <ul class="rows skeleton" aria-busy="true" aria-label={t('home.loading')}>{[0, 1, 2, 3, 4].map((i) => <li key={i} class="agent-row sk"><span class="avatar sk-box" /><span class="row-body"><i class="sk-line w40" /><i class="sk-line w80" /></span></li>)}</ul>}
      {agents && <ul class="rows" ref={host} aria-label={t('nav.recent')}>
        {pinned.length > 0 && !needle && <li class="nav-label" role="presentation">{t('list.pinned')}</li>}
        {rows(pinned)}
        {pinned.length > 0 && rest.length > 0 && !needle && <li class="nav-label" role="presentation">{t('list.all')}</li>}
        {rows(rest)}
        {needle && shown.length === 0 && <li class="list-empty" role="status"><Icon name="search" size={28} class="icon-hero" />{t('list.noMatch')}</li>}
      </ul>}
      {menu && <div class="ctx-menu" ref={menuEl} role="menu" style={{ left: Math.min(menu.x, innerWidth - 220), top: Math.min(menu.y, innerHeight - 70) }}
        onKeyDown={(e) => { if (e.key === 'Tab') setMenu(null); }}>
        <button type="button" role="menuitem" onClick={() => { const a = menu.a; setMenu(null); onPin(a); }}><Icon name={menu.a.pinned ? 'unpin' : 'pin'} size={18} />{t(menu.a.pinned ? 'list.unpin' : 'list.pin')}</button>
      </div>}
    </div>
  );
}
