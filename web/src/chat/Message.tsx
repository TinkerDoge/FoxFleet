import { Icon } from '../components/Icon';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { UiMessage } from '../lib/chat';
import { enhance, isVideoUrl, renderMarkdown } from '../lib/markdown';
import { splitFiles } from '../lib/files';
import type { MediaItem } from '../components/MediaViewer';
import { parseMedia, parseStreaming } from '../lib/mediaTags';
import { MediaCards } from './MediaCards';
import { Reasoning } from './Reasoning';
import { ReactButton, ReactionBar, type ReactionGroup } from './Reactions';
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
const AddReact = ({ r }: { r?: MessageReactions }) => (r ? <span class="msg-actions"><ReactButton onPick={(e) => r.onReact(e, true)} /></span> : null);

export function Message({ m, onMedia, grouped = false, reactions }: { m: UiMessage; onMedia: (m: MediaItem) => void; grouped?: boolean; reactions?: MessageReactions }) {
  if (m.role === 'system') return <div class="msg notice" role="status"><small class="muted">{m.content}</small></div>;
  if (m.role === 'user') {
    const { text, files } = splitFiles(m.content);
    return (
      <div class={`msg user${grouped ? ' grouped' : ''}${reactions?.groups.length ? ' has-reacts' : ''}`}>
        <div class="msg-row">
          {!reactions?.groups.length && <AddReact r={reactions} />}
          <div class="bubble">
            {m.images?.length ? <div class="thumbs">{m.images.map((im, i) => <button key={i} class="thumb" aria-label={t('chat.openImage')} onClick={() => onMedia({ kind: 'image', src: im.dataUrl })}><img src={im.dataUrl} alt="" /></button>)}</div> : null}
            {text && <p class="user-text">{text}</p>}
            <Time ts={m.ts} />
            {files.map((f, i) => <div class="chip" key={i}><Icon name="attach" size={16} /><span class="chip-name">{f.path.split('/').pop()}</span><small>{f.size}</small></div>)}
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
        <div class="msg-card">
          {m.reasoning && <Reasoning text={m.reasoning} ms={m.reasoningMs} />}
          {m.images?.length ? <div class="thumbs">{m.images.map((im, i) => <button key={i} class="thumb" aria-label={t('chat.openImage')} onClick={() => onMedia({ kind: 'image', src: im.dataUrl })}><img src={im.dataUrl} alt="" /></button>)}</div> : null}
          <AssistantText text={m.content} onMedia={onMedia} />
          {m.interrupted && <small class="interrupted muted">{t('chat.interrupted')}</small>}
          <Time ts={m.ts} />
        </div>
        {!reactions?.groups.length && <AddReact r={reactions} />}
      </div>
      <Reacts r={reactions} />
    </div>
  );
}
