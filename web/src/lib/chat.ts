import type { FileRef } from './files';

export interface UiImage { dataUrl: string }
export interface ToolStep { name: string; args?: string; result?: string; ok?: boolean }
export interface UiMessage { role: 'user' | 'assistant' | 'system'; content: string; images?: UiImage[]; reasoning?: string; error?: boolean; tools?: ToolStep[]; ts?: number }

/** One message from the hub's normalised history (already stripped of tool JSON, control tags and hidden rows). */
export function fromHistory(m: any): UiMessage | null {
  if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
  const images = Array.isArray(m.images) ? m.images.filter((u: unknown): u is string => typeof u === 'string').map((dataUrl: string) => ({ dataUrl })) : [];
  const tools: ToolStep[] = Array.isArray(m.tools) ? m.tools.filter((x: any) => x && typeof x.name === 'string').map((x: any) => ({ name: String(x.name), ...(typeof x.args === 'string' ? { args: x.args } : {}), ...(typeof x.result === 'string' ? { result: x.result } : {}), ...(typeof x.ok === 'boolean' ? { ok: x.ok } : {}) })) : [];
  const content = typeof m.content === 'string' ? m.content : '';
  if (!content && !images.length && !tools.length && !m.reasoning) return null;
  return { role: m.role, content, ...(images.length ? { images } : {}), ...(typeof m.reasoning === 'string' && m.reasoning ? { reasoning: m.reasoning } : {}), ...(tools.length ? { tools } : {}), ...(Number(m.ts) ? { ts: Number(m.ts) } : {}) };
}

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
