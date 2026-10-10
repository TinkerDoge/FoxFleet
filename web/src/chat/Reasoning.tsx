import { useState } from 'preact/hooks';
import { Icon } from '../components/Icon';
import { parseStreaming } from '../lib/mediaTags';
import { showReasoning } from '../state';
import { t } from '../i18n/t';
import { Markdown } from './Message';

/** "8 s", "1 min 5 s"; '' when the length is not known. */
export function thoughtTime(ms?: number): string {
  if (!ms || ms <= 0) return '';
  if (ms < 1000) return '<1 s';
  if (ms < 60_000) return `${Math.floor(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.floor((ms % 60_000) / 1000)} s`;
}
export const reasoningLabel = (live: boolean, ms?: number): string => (live ? t('chat.reasoningThinking') : thoughtTime(ms) ? t('chat.reasoningFor', { time: thoughtTime(ms) }) : t('chat.reasoning'));

const memory = new Map<string, { open: boolean; full: boolean }>(); // per message, for as long as the page lives
const keyOf = (text: string, id?: string) => id ?? `r:${text.length}:${text.slice(0, 40)}`;

/** The agent's thinking above a reply. Collapsed until tapped; the open state of each message is remembered. */
export function Reasoning({ text, live = false, ms, id }: { text: string; live?: boolean; ms?: number; id?: string }) {
  if (!showReasoning() || (!text.trim() && !live)) return null;
  const key = live ? 'live' : keyOf(text, id), saved = memory.get(key);
  const [open, setOpen] = useState(saved?.open ?? false), [full, setFull] = useState(saved?.full ?? false), [copied, setCopied] = useState(false);
  const remember = (o: boolean, f: boolean) => { memory.set(key, { open: o, full: f }); setOpen(o); setFull(f); };
  const body = parseStreaming(text).text, label = reasoningLabel(live, ms);
  return (
    <div class={`reasoning${open ? ' open' : ''}${live ? ' live' : ''}`} data-testid="reasoning">
      <button type="button" class="reasoning-head" aria-expanded={open} aria-label={`${open ? t('chat.reasoningHide') : t('chat.reasoningShow')}, ${label}`} onClick={() => remember(!open, full)}>
        <Icon name="reasoning" size={18} />
        <span class={live ? 'shimmer' : ''}>{label}</span>
        <Icon name="chevronDown" size={20} class="chev" />
      </button>
      <div class="reasoning-body" aria-hidden={!open}>
        <div class="reasoning-inner">
          <div class={`reasoning-text${full ? ' full' : ''}`} tabIndex={open ? 0 : -1}><Markdown text={body} onMedia={() => {}} /></div>
          <div class="reasoning-actions">
            {body.length > 400 && <button type="button" class="link" onClick={() => remember(open, !full)}>{full ? t('chat.reasoningLess') : t('chat.reasoningMore')}</button>}
            <button type="button" class="link" aria-label={t('chat.reasoningCopy')} onClick={() => { void navigator.clipboard?.writeText(body).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}><Icon name="copy" size={16} /> {copied ? t('chat.copied') : t('chat.copy')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
