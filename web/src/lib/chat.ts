import type { FileRef } from './files';

export interface UiImage { dataUrl: string }
export interface UiMessage { role: 'user' | 'assistant' | 'system'; content: string; images?: UiImage[]; reasoning?: string; error?: boolean }

/**
 * OpenAI-style messages for the hub. Only the newest user turn carries image bytes; older images collapse to "[image]"
 * so a conversation with photos never re-uploads them.
 */
export function chatMessages(history: UiMessage[]) {
  const lastUser = history.map((m) => m.role).lastIndexOf('user');
  return history.map((m, i) => {
    if (!m.images?.length) return { role: m.role, content: m.content };
    if (i === lastUser) return { role: m.role, content: [...(m.content.trim() ? [{ type: 'text', text: m.content }] : []), ...m.images.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } }))] };
    return { role: m.role, content: `${m.images.map(() => '[image]').join(' ')} ${m.content}`.trim() };
  });
}
export const HUB_BODY_LIMIT = 10 * 1024 * 1024;
export const estimatedBytes = (h: UiMessage[]) => JSON.stringify(chatMessages(h)).length;
export type { FileRef };
