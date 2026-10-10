import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import { Icon } from '../components/Icon';
import type { MediaItem } from '../components/MediaViewer';
import { PROXY } from '../lib/markdown';
import { isData, isUrl, type MediaRef } from '../lib/mediaTags';
import { t } from '../i18n/t';
import { allowCommand, mediaProblem, type MediaProblemInput, type MediaProblemKind } from './mediaProblems';

export interface Resolved { url: string; kind: 'image' | 'video' | 'audio' | 'file'; name: string }
/** Turns a MEDIA: ref into a link the browser can load. Provided by the chat screen (it knows the client and the agent). */
export const MediaContext = createContext<((ref: string) => Promise<Resolved>) | null>(null);
/** Asks why a resolved link failed to load (provided with MediaContext). */
export const DiagnoseContext = createContext<((url: string) => Promise<MediaProblemInput>) | null>(null);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The hub learns a ref when the reply is stored; a card shown a moment earlier asks again briefly instead of failing. */
async function resolveWithRetry(resolve: (ref: string) => Promise<Resolved>, ref: string): Promise<Resolved> {
  for (let n = 0; ; n++) { try { return await resolve(ref); } catch (e: any) { if (n >= 3 || (e?.status && e.status !== 404 && e.status < 500)) throw e; await sleep(500 * (n + 1)); } }
}

function Card({ m, onMedia }: { m: MediaRef; onMedia: (m: MediaItem) => void }) {
  const resolve = useContext(MediaContext);
  const direct = m.kind === 'image' && isData(m.ref) ? m.ref : m.kind === 'image' && isUrl(m.ref) ? PROXY + encodeURIComponent(m.ref) : null; // data: pictures carry their own bytes; remote pictures use the existing SSRF-guarded image proxy
  const [res, setRes] = useState<Resolved | null>(direct ? { url: direct, kind: 'image', name: m.name } : null);
  const diagnose = useContext(DiagnoseContext);
  const [failed, setFailed] = useState<MediaProblemKind | false>(false), [tick, setTick] = useState(0), [copied, setCopied] = useState(false);
  const fail = (why?: MediaProblemInput) => setFailed(mediaProblem(why ?? {}));
  const failLink = (url: string) => { if (diagnose && !isData(url)) void diagnose(url).then((w) => fail(w.status === 200 || w.status === 206 ? undefined : w), () => fail()); else fail(); };
  useEffect(() => {
    if (direct || !resolve) return; let live = true; setFailed(false);
    resolveWithRetry(resolve, m.ref).then((r) => live && setRes(r), (e) => live && fail({ status: e?.status, code: e?.code, message: e?.message, network: e?.name === 'NetworkError' }));
    return () => { live = false; };
  }, [m.ref, tick]);
  const kind = res?.kind ?? m.kind;
  if (failed || (!res && !resolve)) {
    const why: MediaProblemKind = failed || 'generic', cmd = why === 'outside' ? allowCommand(m.ref) : '';
    return <div class="media-card muted failed" role="group" aria-label={m.name}><Icon name="attach" size={18} /><span class="media-name">{m.name}</span><small>{t(`media.err.${why}`)}</small>
      {cmd && <small class="media-hint">{t('media.hint.outside', { command: cmd })}</small>}
      {cmd && <button class="btn small" type="button" onClick={() => { void navigator.clipboard?.writeText(cmd); setCopied(true); }}>{copied ? t('media.copied') : t('media.copyFix')}</button>}
      {failed && why !== 'hub_too_old' && <button class="btn small" type="button" onClick={() => setTick(tick + 1)}>{t('media.retry')}</button>}</div>;
  }
  if (!res) return <div class={`media-card loading ${kind}`} role="status" aria-label={t('media.loading', { name: m.name })}><span class="media-skel" /><span class="media-name">{m.name}</span></div>;
  if (kind === 'image') return <button type="button" class="media-card image" aria-label={t('chat.openImage') + ': ' + m.name} onClick={() => onMedia({ kind: 'image', src: res.url, alt: m.name })}><img src={res.url} alt={m.name} loading="lazy" onError={() => failLink(res.url)} /></button>;
  if (kind === 'video') return <div class="media-card video"><video src={res.url} controls preload="metadata" playsInline aria-label={m.name} onError={() => failLink(res.url)} /></div>;
  if (kind === 'audio') return <div class={`media-card audio${m.voice ? ' voice' : ''}`}><span class="media-name">{m.voice ? t('media.voice') : m.name}</span><audio src={res.url} controls preload="metadata" aria-label={m.name} onError={() => failLink(res.url)} /></div>;
  return <a class="media-card file" href={res.url} download={m.name} rel="noopener noreferrer"><Icon name="attach" size={18} /><span class="media-name">{m.name}</span><small>{t('media.download')}</small></a>;
}

export function MediaCards({ media, onMedia }: { media: MediaRef[]; onMedia: (m: MediaItem) => void }) {
  if (!media.length) return null;
  return <div class="media-cards">{media.map((m) => <Card key={m.ref} m={m} onMedia={onMedia} />)}</div>;
}
