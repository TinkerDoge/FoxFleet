import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { UiMessage } from '../lib/chat';
import { enhance, isVideoUrl, renderMarkdown } from '../lib/markdown';
import { splitFiles } from '../lib/files';
import type { MediaItem } from '../components/MediaViewer';
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

function Tools({ m }: { m: UiMessage }) {
  if (!m.tools?.length) return null;
  const failed = m.tools.filter((x) => x.ok === false).length;
  return (
    <details class="tools">
      <summary>{t(m.tools.length === 1 ? 'chat.toolsOne' : 'chat.toolsMany', { n: m.tools.length })}{failed ? ` · ${t('chat.toolsFailed', { n: failed })}` : ''}</summary>
      <ul>{m.tools.map((x, i) => <li key={i} class={x.ok === false ? 'bad' : ''}><b>{x.name}</b>{x.args && <code>{x.args}</code>}{x.result && <span class="muted">{x.result}</span>}</li>)}</ul>
    </details>
  );
}
const Time = ({ ts }: { ts?: number }) => (ts ? <time class="msg-time muted" dateTime={new Date(ts).toISOString()}>{clock(ts)}</time> : null);

export function Message({ m, onMedia, grouped = false }: { m: UiMessage; onMedia: (m: MediaItem) => void; grouped?: boolean }) {
  if (m.role === 'system') return <div class="msg notice" role="status"><small class="muted">{m.content}</small></div>;
  if (m.role === 'user') {
    const { text, files } = splitFiles(m.content);
    return (
      <div class={`msg user${grouped ? ' grouped' : ''}`}>
        <div class="bubble">
          {m.images?.length ? <div class="thumbs">{m.images.map((im, i) => <button key={i} class="thumb" aria-label={t('chat.openImage')} onClick={() => onMedia({ kind: 'image', src: im.dataUrl })}><img src={im.dataUrl} alt="" /></button>)}</div> : null}
          {text && <p class="user-text">{text}</p>}
          <Time ts={m.ts} />
          {files.map((f, i) => <div class="chip" key={i}><span aria-hidden="true">📎</span><span class="chip-name">{f.path.split('/').pop()}</span><small>{f.size}</small></div>)}
        </div>
      </div>
    );
  }
  return (
    <div class={`msg assistant${m.error ? ' err' : ''}${grouped ? ' grouped' : ''}`}>
      {m.reasoning && <details class="reasoning"><summary>{t('chat.reasoning')}</summary><div class="md plain">{m.reasoning}</div></details>}
      <Tools m={m} />
      {m.images?.length ? <div class="thumbs">{m.images.map((im, i) => <button key={i} class="thumb" aria-label={t('chat.openImage')} onClick={() => onMedia({ kind: 'image', src: im.dataUrl })}><img src={im.dataUrl} alt="" /></button>)}</div> : null}
      {m.content && <Markdown text={m.content} onMedia={onMedia} />}
      {m.interrupted && <small class="interrupted muted">{t('chat.interrupted')}</small>}
      <Time ts={m.ts} />
    </div>
  );
}
