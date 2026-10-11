import { Icon } from '../components/Icon';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { UiMessage } from '../lib/chat';
import { enhance, isVideoUrl, renderMarkdown } from '../lib/markdown';
import { splitFiles } from '../lib/files';
import type { MediaItem } from '../components/MediaViewer';
import { parseMedia, parseStreaming } from '../lib/mediaTags';
import { MediaCards } from './MediaCards';
import { Reasoning } from './Reasoning';
import { ReactButton, ReactionBar, type ReactionGroup } from './Reactions';
import { createDoubleTap, splitQuote } from './messageActions';
import { t } from '../i18n/t';

export function Markdown({ text, onMedia }: { text: string; onMedia: (m: MediaItem) => void }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) { ref.current.innerHTML = html; enhance(ref.current); } }, [html]);
  function click(e: MouseEvent) {
    const el = e.target as HTMLElement;
    const copy = el.closest('[data-copy]') as HTMLButtonElement | null;
    if (copy) { const code = copy.closest('.code')?.querySelector('code')?.textContent ?? ''; void navigator.clipboard?.writeText(code).then(() => { copy.textContent = t('chat.copied'); setTimeout(() => (copy.textContent = t('chat.copy')), 1500); }); return; }
    const img = el.closest('img[data-viewable]') as HTMLImageElement | null;
    if (img) { onMedia({ kind: 'image', src: img.src, alt: img.alt }); return; }
    const a = el.closest('a') as HTMLAnchorElement | null;
    if (a && isVideoUrl(a.href)) { e.preventDefault(); onMedia({ kind: 'video', src: a.href }); }
  }
  return <div class="md" ref={ref} onClick={click} />;
}

import { clock } from '../lib/time';

const Time = ({ ts }: { ts?: number }) => (ts ? <time class="msg-time muted" dateTime={new Date(ts).toISOString()}>{clock(ts)}</time> : null);

/** Reply text with MEDIA: tags removed from view and shown as picture / video / audio / file cards underneath. */
export function AssistantText({ text, onMedia, streaming = false }: { text: string; onMedia: (m: MediaItem) => void; streaming?: boolean }) {
  const parsed = useMemo(() => (streaming ? parseStreaming(text) : parseMedia(text)), [text, streaming]);
  return <>{parsed.text && <Markdown text={parsed.text} onMedia={onMedia} />}<MediaCards media={parsed.media} onMedia={onMedia} /></>;
}

/** Reactions for one message: pills plus an add button. Absent until the message has a stable hub id. */
export interface MessageReactions { groups: ReactionGroup[]; me: string; onReact: (emoji: string, present: boolean) => void }
const Reacts = ({ r }: { r?: MessageReactions }) => (r ? <ReactionBar groups={r.groups} me={r.me} onReact={r.onReact} /> : null);
/** How a message reacts to the hand: open the menu at a point, or toggle your heart. */
export interface MessageGestures { open: (x: number, y: number) => void; heart?: () => void }
/** Presses on these stay theirs: links, pictures and buttons keep their own tap, long-press and native menu. */
const INTERACTIVE = 'a,button,img,video,audio,input,textarea,summary';
const NATIVE_MENU = 'a,img,video,audio';
const LONG_PRESS = 500, SLOP = 10;
const inside = (t: EventTarget | null, sel: string) => !!(t as Element | null)?.closest?.(sel);

/**
 * Right-click / long-press (touch, 500 ms) opens the menu; a touch double tap hearts (a mouse double click does not, it selects
 * a word). Listeners are added by hand on the returned ref: Preact would bind `onPointerUp` as "PointerUp" where the DOM has no
 * `onpointerup` property (jsdom). Right-click on a link, picture or selected text keeps the browser's own menu.
 */
function useGestures(g: MessageGestures | undefined, kind: string) {
  const el = useRef<HTMLDivElement>(null), latest = useRef(g), [tap] = useState(() => createDoubleTap()), [pop, setPop] = useState(0);
  const press = useRef({ timer: 0 as ReturnType<typeof setTimeout> | 0, x: 0, y: 0, touching: false, opened: false });
  latest.current = g;
  const on = !!g;
  useEffect(() => {
    const node = el.current, p = press.current;
    if (!on || !node) return;
    const cancel = () => { if (p.timer) clearTimeout(p.timer); p.timer = 0; };
    const longOpen = (x: number, y: number) => { p.opened = true; try { getSelection()?.removeAllRanges(); } catch { /* no selection API */ } latest.current?.open(x, y); };
    const down = (e: PointerEvent) => {
      cancel(); p.opened = false; p.touching = e.pointerType === 'touch';
      if (!p.touching || inside(e.target, INTERACTIVE)) return;
      p.x = e.clientX; p.y = e.clientY;
      p.timer = setTimeout(() => { p.timer = 0; longOpen(p.x, p.y); }, LONG_PRESS);
    };
    // A still finger still jitters a few pixels; only a real move (a scroll or a drag) cancels the press.
    const move = (e: PointerEvent) => { if (p.timer && Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP) cancel(); };
    const stop = () => { cancel(); p.touching = false; p.opened = false; };
    const up = (e: PointerEvent) => {
      const opened = p.opened; stop();
      const heart = latest.current?.heart;
      if (e.pointerType !== 'touch' || opened || !heart || inside(e.target, INTERACTIVE)) return;
      if (tap(e.clientX, e.clientY)) { heart(); setPop((n) => n + 1); }
    };
    const menu = (e: MouseEvent) => {
      if (p.touching) { // Android also fires contextmenu on a long press: one menu, never the native one or a text selection
        if (inside(e.target, INTERACTIVE)) return;
        e.preventDefault(); if (!p.opened) { cancel(); longOpen(e.clientX, e.clientY); }
        return;
      }
      const sel = typeof getSelection === 'function' ? getSelection() : null;
      if (inside(e.target, NATIVE_MENU) || (sel && !sel.isCollapsed && sel.toString().trim() && node.contains(sel.anchorNode))) return;
      e.preventDefault();
      // The context-menu key reports 0,0: open at the message instead of the window corner.
      const r = node.getBoundingClientRect(), key = !e.clientX && !e.clientY;
      latest.current?.open(key ? r.left : e.clientX, key ? r.top : e.clientY);
    };
    node.addEventListener('pointerdown', down); node.addEventListener('pointermove', move); node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', stop); node.addEventListener('contextmenu', menu);
    return () => {
      cancel();
      node.removeEventListener('pointerdown', down); node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', stop); node.removeEventListener('contextmenu', menu);
    };
  }, [on, kind]);
  return { ref: el, pop };
}
const HeartPop = ({ n }: { n: number }) => (n ? <span key={n} class="heart-pop" aria-hidden="true">❤️</span> : null);
const More = ({ g }: { g?: MessageGestures }) => (g ? <button type="button" class="msg-more" aria-label={t('msg.actions')} title={t('msg.actions')} aria-haspopup="menu"
  onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); g.open(r.left, r.bottom); }}><Icon name="more" size={18} /></button> : null);
const Actions = ({ r, g }: { r?: MessageReactions; g?: MessageGestures }) => (r || g ? <span class="msg-actions">{r && !r.groups.length && <ReactButton onPick={(e) => r.onReact(e, true)} />}<More g={g} /></span> : null);

export function Message({ m, onMedia, grouped = false, reactions, gestures }: { m: UiMessage; onMedia: (m: MediaItem) => void; grouped?: boolean; reactions?: MessageReactions; gestures?: MessageGestures }) {
  // Called before the early return so the hook order never changes.
  const { ref, pop } = useGestures(m.role === 'system' ? undefined : gestures, m.role);
  if (m.role === 'system') return <div class="msg notice" role="status"><small class="muted">{m.content}</small></div>;
  if (m.role === 'user') {
    const { text, files } = splitFiles(m.content), q = splitQuote(text), body = q ? q.body : text;
    return (
      <div class={`msg user${grouped ? ' grouped' : ''}${reactions?.groups.length ? ' has-reacts' : ''}`}>
        <div class="msg-row">
          <Actions r={reactions} g={gestures} />
          <div class="bubble" ref={ref}>
            {m.images?.length ? <div class="thumbs">{m.images.map((im, i) => <button key={i} class="thumb" aria-label={t('chat.openImage')} onClick={() => onMedia({ kind: 'image', src: im.dataUrl })}><img src={im.dataUrl} alt="" /></button>)}</div> : null}
            {q && <blockquote class="reply-quote">{q.quote}</blockquote>}
            {body && <p class="user-text">{body}</p>}
            <Time ts={m.ts} />
            {files.map((f, i) => <div class="chip" key={i}><Icon name="attach" size={16} /><span class="chip-name">{f.path.split('/').pop()}</span><small>{f.size}</small></div>)}
            <HeartPop n={pop} />
          </div>
        </div>
        <Reacts r={reactions} />
      </div>
    );
  }
  return (
    <div class={`msg assistant${m.error ? ' err' : ''}${grouped ? ' grouped' : ''}${reactions?.groups.length ? ' has-reacts' : ''}`}>
      {/* One frame per reply: reasoning, text, pictures and time belong to it, so it is clear what a reaction is on. */}
      <div class="msg-row">
        <div class="msg-card" ref={ref}>
          {m.reasoning && <Reasoning text={m.reasoning} ms={m.reasoningMs} />}
          {m.images?.length ? <div class="thumbs">{m.images.map((im, i) => <button key={i} class="thumb" aria-label={t('chat.openImage')} onClick={() => onMedia({ kind: 'image', src: im.dataUrl })}><img src={im.dataUrl} alt="" /></button>)}</div> : null}
          <AssistantText text={m.content} onMedia={onMedia} />
          {m.interrupted && <small class="interrupted muted">{t('chat.interrupted')}</small>}
          <Time ts={m.ts} />
          <HeartPop n={pop} />
        </div>
        <Actions r={reactions} g={gestures} />
      </div>
      <Reacts r={reactions} />
    </div>
  );
}
