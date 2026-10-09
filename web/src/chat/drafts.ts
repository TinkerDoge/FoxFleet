import { useLayoutEffect, useState } from 'preact/hooks';
import type { FileRef } from '../lib/files';

export type PendingAttachment =
  | { id: number; kind: 'image'; dataUrl: string; name: string }
  | { id: number; kind: 'file'; name: string; size: number; progress: number; ref?: FileRef; error?: string; abort: AbortController };

interface Draft { text: string; pending: PendingAttachment[] }
type Update = Draft | ((draft: Draft) => Draft);
const empty: Draft = { text: '', pending: [] };
const drafts = new Map<string, Draft>(), subscribers = new Set<() => void>();
let generation = 0;

// Keep unsent content in memory only, separate for every agent/session and cleared on sign-out.
export const draftKey = (agent: string, session?: string) => JSON.stringify([agent, session ?? null]);
const notify = () => subscribers.forEach((fn) => fn());
const abortUploads = (draft?: Draft) => draft?.pending.forEach((p) => { if (p.kind === 'file') p.abort.abort(); });

export function discardDraft(key: string) { abortUploads(drafts.get(key)); drafts.delete(key); notify(); }
export function resetDrafts() { generation++; drafts.forEach(abortUploads); drafts.clear(); notify(); }

export function useDraft(key: string): [Draft, (update: Update) => void] {
  const [, bump] = useState(0);
  useLayoutEffect(() => {
    const changed = () => bump((n) => n + 1);
    subscribers.add(changed);
    return () => { subscribers.delete(changed); };
  }, [key]);
  const currentGeneration = generation;
  return [drafts.get(key) ?? empty, (update) => {
    // Uploads or image processing started before sign-out must not restore the old account's draft.
    if (currentGeneration !== generation) return;
    const draft = typeof update === 'function' ? update(drafts.get(key) ?? empty) : update;
    if (draft.text || draft.pending.length) drafts.set(key, draft); else drafts.delete(key);
    notify();
  }];
}
