import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import { Icon } from '../components/Icon';
import { t } from '../i18n/t';
import { QUICK } from './messageActions';

export interface ReactionActor { id: string; name: string; kind: 'human' | 'agent' }
export interface ReactionGroup { emoji: string; actors: ReactionActor[] }
/** The hub's answer for one conversation: who "you" are, the reactions on each stable message id, and what you hid. */
export interface ReactionSnapshot { actor: ReactionActor; messages: Record<string, ReactionGroup[]>; hidden?: string[] }
export interface CatalogEntry { emoji: string; name: string; asset: string }

export { QUICK };

/** Optimistic local change; the hub's idempotent PUT/DELETE make the same change, so a retry never flips it back. */
export function applyReaction(s: ReactionSnapshot, message: string, emoji: string, present: boolean): ReactionSnapshot {
  const groups = (s.messages[message] ?? []).map((g) => ({ ...g, actors: g.actors.filter((a) => a.id !== s.actor.id || g.emoji !== emoji) }));
  const at = groups.findIndex((g) => g.emoji === emoji);
  if (present) { if (at >= 0) groups[at].actors.push(s.actor); else groups.push({ emoji, actors: [s.actor] }); }
  return { ...s, messages: { ...s.messages, [message]: groups.filter((g) => g.actors.length) } };
}
/** Optimistic "delete for me"; the hub's PUT/DELETE make the same change. */
export function applyHidden(s: ReactionSnapshot, message: string, present: boolean): ReactionSnapshot {
  const h = new Set(s.hidden ?? []); if (present) h.add(message); else h.delete(message);
  return { ...s, hidden: [...h] };
}

// ---- bundled Twemoji artwork (no CDN); Unicode is what we store, artwork is only how we draw it ----
let catalog: Promise<CatalogEntry[]> | null = null, byEmoji: Map<string, string> | null = null;
const strip = (e: string) => e.replace(/️/g, '');
export function loadCatalog(): Promise<CatalogEntry[]> {
  catalog ??= fetch('/emoji/catalog.json').then((r) => (r.ok ? r.json() : [])).then((list: CatalogEntry[]) => {
    byEmoji = new Map(); for (const e of list) { byEmoji.set(e.emoji, e.asset); if (!byEmoji.has(strip(e.emoji))) byEmoji.set(strip(e.emoji), e.asset); }
    return list;
  }).catch(() => { catalog = null; return []; });
  return catalog;
}
function useCatalog() {
  const [list, setList] = useState<CatalogEntry[] | null>(byEmoji ? [] : null);
  useEffect(() => { let on = true; void loadCatalog().then((l) => { if (on) setList(l); }); return () => { on = false; }; }, []);
  return list;
}
/** Twemoji picture when bundled, else the emoji as text (future emoji are kept, never dropped). */
export function Emoji({ value, size = 18 }: { value: string; size?: number }) {
  useCatalog();
  const asset = byEmoji?.get(value) ?? byEmoji?.get(strip(value));
  return asset ? <img class="emoji" src={`/emoji/${asset}.png`} alt={value} width={size} height={size} draggable={false} /> : <span class="emoji-text" style={{ fontSize: size }}>{value}</span>;
}

const who = (g: ReactionGroup, me: string) => g.actors.map((a) => (a.id === me ? t('react.you') : a.kind === 'agent' ? t('react.agent', { name: a.name }) : a.name)).join(', ');

/** Pills under a message, plus the add button. Tapping your own pill removes it; tapping another adds yours. */
export function ReactionBar({ groups, me, onReact, canAdd = true }: { groups: ReactionGroup[]; me: string; onReact: (emoji: string, present: boolean) => void; canAdd?: boolean }) {
  if (!groups.length) return null;
  return (
    <div class="reactions" role="group" aria-label={t('react.list')}>
      {groups.map((g) => {
        const mine = g.actors.some((a) => a.id === me), names = who(g, me);
        return <button type="button" key={g.emoji} class={`react-pill${mine ? ' mine' : ''}`} aria-pressed={mine} title={names}
          aria-label={t('react.pill', { emoji: g.emoji, n: g.actors.length, who: names })} onClick={() => onReact(g.emoji, !mine)}>
          <Emoji value={g.emoji} size={16} /><span class="react-count">{g.actors.length}</span>
        </button>;
      })}
      {canAdd && <ReactButton onPick={(e) => onReact(e, true)} small />}
    </div>
  );
}

/** The "add reaction" trigger with its popover picker. */
export function ReactButton({ onPick, small = false }: { onPick: (emoji: string) => void; small?: boolean }) {
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null);
  return <span class="react-anchor">
    <button type="button" ref={trigger} class={`react-add${small ? ' small' : ''}`} aria-label={t('react.add')} title={t('react.add')} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon name="react" size={small ? 16 : 18} />
    </button>
    {open && <EmojiPicker onPick={(e) => { setOpen(false); trigger.current?.focus(); onPick(e); }} onClose={() => { setOpen(false); trigger.current?.focus(); }} />}
  </span>;
}

/** Quick row plus the whole searchable catalog (skin tones and joined sequences included when searched). */
export function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const list = useCatalog(), [q, setQ] = useState(''), box = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    input.current?.focus();
    const outside = (e: Event) => { if (!box.current?.parentElement?.contains(e.target as Node)) onClose(); }; // the trigger toggles itself
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);
  const shown = useMemo(() => {
    if (!list) return [];
    const s = q.trim().toLowerCase();
    return s ? list.filter((e) => e.name.includes(s) || e.emoji === q.trim()) : list.filter((e) => !e.name.includes('skin tone'));
  }, [list, q]);
  return (
    <div class="emoji-picker" ref={box} role="dialog" aria-label={t('react.pick')}>
      <div class="emoji-quick">{QUICK.map((e) => <button type="button" key={e} aria-label={e} onClick={() => onPick(e)}><Emoji value={e} size={24} /></button>)}</div>
      <label class="search emoji-search"><Icon name="search" size={18} /><input ref={input} type="search" value={q} placeholder={t('react.search')} aria-label={t('react.search')} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} /></label>
      <div class="emoji-grid" role="list">
        {!list ? <p class="muted small">{t('react.loading')}</p> : !shown.length ? <p class="muted small">{t('react.noMatch')}</p>
          : shown.map((e) => <button type="button" role="listitem" key={e.emoji} title={e.name} aria-label={e.name} onClick={() => onPick(e.emoji)}><img src={`/emoji/${e.asset}.png`} alt="" width={26} height={26} loading="lazy" /></button>)}
      </div>
      <small class="emoji-credit muted"><a href="https://github.com/jdecked/twemoji" target="_blank" rel="noopener noreferrer">Twemoji</a> · <a href="/emoji/LICENSE-GRAPHICS.txt" target="_blank" rel="noopener">CC BY 4.0</a></small>
    </div>
  );
}

/**
 * Reactions for the open conversation. Refreshes on open, when the message ids change, when the tab returns and every 30 s
 * while visible, so a second client (or an agent) shows up without a reload. Changes are optimistic and roll back on failure.
 */
export function useReactions(client: Client, agent: string, session: string | undefined, ids: string, enabled: boolean) {
  const [snap, setSnap] = useState<ReactionSnapshot | null>(null), [error, setError] = useState('');
  const key = useRef(''), pending = useRef(0);
  const current = `${agent}\u0000${session ?? ''}`;
  const refresh = () => {
    if (!enabled || !session) return;
    const k = current; void client.reactions(agent, session).then((s) => { if (key.current === k && pending.current === 0) setSnap(s); }).catch(() => {});
  };
  useEffect(() => { key.current = current; setSnap(null); setError(''); }, [current]);
  useEffect(() => { refresh(); }, [current, ids, enabled]);
  useEffect(() => {
    if (!enabled || !session) return;
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    const timer = setInterval(visible, 30_000);
    document.addEventListener('visibilitychange', visible); window.addEventListener('focus', visible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible); };
  }, [current, enabled]);
  const react = (message: string, emoji: string, present: boolean) => {
    if (!snap || !session) return;
    const before = snap, k = current; let failed = false;
    setSnap(applyReaction(snap, message, emoji, present)); setError(''); pending.current++;
    void client.react(agent, session, message, emoji, present)
      .then((s) => { if (key.current === k && pending.current === 1) setSnap(s); })
      .catch(() => { failed = true; if (key.current === k) { setSnap(before); setError(t('react.failed')); } })
      .finally(() => { pending.current--; if (failed) refresh(); }); // then trust the hub, not our guess
  };
  const hide = (message: string, present: boolean) => {
    if (!snap || !session) return;
    const before = snap, k = current; let failed = false;
    setSnap(applyHidden(snap, message, present)); setError(''); pending.current++;
    void client.hide(agent, session, message, present)
      .then((s) => { if (key.current === k && pending.current === 1) setSnap(s); })
      .catch(() => { failed = true; if (key.current === k) { setSnap(before); setError(t('msg.hideFailed')); } })
      .finally(() => { pending.current--; if (failed) refresh(); });
  };
  return { snap, error, react, hide, refresh };
}
