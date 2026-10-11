import type { UiMessage } from '../lib/chat';
import { splitFiles } from '../lib/files';
import { parseMedia } from '../lib/mediaTags';
import type { ReactionGroup } from './Reactions';

/** Quick reactions, in menu order (the smiley-plus button opens the full picker). */
export const QUICK = ['👍', '👎', '❤️', '🎉', '😮'];
export const HEART = '❤️';
export interface ReplyTarget { author: string; excerpt: string }
export type MessageAction = 'reply' | 'copy' | 'select' | 'share' | 'retry' | 'edit' | 'delete';

/** The quote line, then a blank line; or the quote alone (a reply with only pictures: the send trims the blank line away). */
const QUOTE = /^> ([^\n]*)(?:\n\n|$)/;
/** A reply's leading quote line, split from the rest; null when the text does not start with one. */
export function splitQuote(text: string): { quote: string; body: string } | null {
  const m = QUOTE.exec(text); return m ? { quote: m[1], body: text.slice(m[0].length) } : null;
}
/** The text a reply sends: the quoted excerpt on its own line, a blank line, then what the user wrote. */
export const withQuote = (reply: ReplyTarget | null | undefined, text: string) => (reply ? `> ${reply.excerpt}\n\n${text}` : text);

/** What a person sees of a message as plain text: tags, REACT: lines, file lines and a reply quote removed. */
export function displayText(m: UiMessage): string {
  if (m.role === 'assistant') return parseMedia(m.content).text;
  const { text } = splitFiles(m.content); return splitQuote(text)?.body ?? text;
}
/** One line, at most 140 characters, for the quote line of a reply. */
export function excerpt(m: UiMessage): string {
  const t = displayText(m).replace(/\s+/g, ' ').trim(), cp = Array.from(t);
  if (cp.length) return cp.length > 140 ? cp.slice(0, 139).join('') + '…' : t;
  const media = m.role === 'assistant' ? parseMedia(m.content).media : [];
  if (m.images?.length || media.some((x) => x.kind === 'image' || x.kind === 'video')) return '[image]';
  if (media.some((x) => x.kind === 'audio')) return '[voice]';
  return '[file]';
}
/** A finished reply that is only a REACT: line (or nothing) draws no row; its reaction shows on the user's message. */
export function emptyReply(m: UiMessage): boolean {
  if (m.role !== 'assistant' || m.reasoning || m.images?.length || m.error || m.interrupted) return false;
  const p = parseMedia(m.content); return !p.text.trim() && !p.media.length;
}
export const visibleMessages = (messages: UiMessage[], hidden: ReadonlySet<string>) => messages.filter((m) => !(m.id && hidden.has(m.id)) && !emptyReply(m));

/**
 * The messages Retry and Edit apply to. Retry: the newest reply, only while it is the last message (notices aside), since it
 * sends the last user message again. Edit: the newest user message, only once a reply follows it (/undo takes back a whole exchange).
 */
export function newestTargets(messages: UiMessage[]): { assistant?: UiMessage; user?: UiMessage } {
  const turns = messages.filter((m) => m.role !== 'system'), last = turns[turns.length - 1];
  let user: UiMessage | undefined, replied = false;
  for (let i = turns.length - 1; i >= 0; i--) { if (turns[i].role === 'assistant') replied = true; else if (turns[i].role === 'user') { user = turns[i]; break; } }
  return { assistant: last?.role === 'assistant' ? last : undefined, user: replied ? user : undefined };
}
/** Which actions a message offers, in menu order. Delete needs a hub id; Retry/Edit only on the newest message of that side, and never while busy (a reply streaming or messages waiting). */
export function messageActions(m: UiMessage, o: { newestAssistant: boolean; newestUser: boolean; busy: boolean; hermes: boolean; canShare: boolean; canHide: boolean; selectable: boolean }): MessageAction[] {
  const out: MessageAction[] = ['reply'];
  if (displayText(m).trim()) { out.push('copy'); if (o.selectable) out.push('select'); if (o.canShare) out.push('share'); }
  if (m.role === 'assistant' && o.newestAssistant && !o.busy) out.push('retry');
  if (m.role === 'user' && o.newestUser && o.hermes && !o.busy) out.push('edit');
  if (m.id && o.canHide) out.push('delete');
  return out;
}
/** Picking an emoji adds it, or takes yours back when you already reacted with it (like a pill). Returns the `present` value to send. */
export const nextReaction = (groups: ReactionGroup[], me: string, emoji: string) => !groups.some((g) => g.emoji === emoji && g.actors.some((a) => a.id === me));
/** Double-tap: add a heart, or take yours back. */
export const nextHeart = (groups: ReactionGroup[], me: string) => nextReaction(groups, me, HEART);
/** Touch double-tap: two taps within 300 ms and 24 px (a third tap starts over). */
export function createDoubleTap(now: () => number = () => Date.now()) {
  let last: { t: number; x: number; y: number } | null = null;
  return (x: number, y: number) => {
    const t = now(), hit = !!last && t - last.t <= 300 && Math.hypot(x - last.x, y - last.y) <= 24;
    last = hit ? null : { t, x, y }; return hit;
  };
}
