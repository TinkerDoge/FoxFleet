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

// Unsent text is remembered per agent and session, like a messenger does: it survives a reload or closing the browser.
// It is stored in localStorage under the signed-in user's id (so accounts sharing a browser never see each other's text),
// debounced, and wiped on sign-out. Only the text is stored: attachments (live uploads, image data) stay in memory.
const PREFIX = 'foxfleet.draft.', DEBOUNCE_MS = 400, MAX_CHARS = 20_000;
let scope: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
const dirty = new Set<string>();
const safe = <T,>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };
const storeKey = (key: string) => (scope ? `${PREFIX}${scope}:${key}` : undefined);

export const draftKey = (agent: string, session?: string) => JSON.stringify([agent, session ?? null]);
const notify = () => subscribers.forEach((fn) => fn());
const abortUploads = (draft?: Draft) => draft?.pending.forEach((p) => { if (p.kind === 'file') p.abort.abort(); });

function write(key: string) {
  const k = storeKey(key); if (!k) return;
  const text = drafts.get(key)?.text ?? '';
  safe(() => { if (text.trim()) localStorage.setItem(k, text.slice(0, MAX_CHARS)); else localStorage.removeItem(k); }, undefined);
}
/** Writes everything waiting for the debounce now (also on pagehide, so closing the tab right after typing keeps the text). */
export function flushDrafts() { if (timer) clearTimeout(timer); timer = undefined; for (const key of dirty) write(key); dirty.clear(); }
function schedule(key: string) { dirty.add(key); if (timer) clearTimeout(timer); timer = setTimeout(flushDrafts, DEBOUNCE_MS); }
function read(key: string): Draft | undefined {
  const have = drafts.get(key); if (have) return have;
  const k = storeKey(key), text = k ? safe(() => localStorage.getItem(k), null) : null;
  if (!text) return undefined;
  const d: Draft = { text, pending: [] }; drafts.set(key, d); return d;
}

/** Call with the signed-in user's id (or undefined when signed out). A different user starts with a clean slate. */
export function setDraftScope(userId?: string) {
  if (userId === scope) return;
  flushDrafts(); generation++; drafts.forEach(abortUploads); drafts.clear(); scope = userId; // no notify: this runs while the shell renders, before any composer reads its draft
}
export function discardDraft(key: string) { abortUploads(drafts.get(key)); drafts.delete(key); dirty.delete(key); const k = storeKey(key); if (k) safe(() => localStorage.removeItem(k), undefined); notify(); }
/** A new chat gets its session id mid-conversation: text typed meanwhile follows the chat instead of being orphaned under the old key (never overwrites an existing draft). */
export function moveDraft(from: string, to: string) {
  const d = read(from); if (!d || from === to || read(to)) return;
  drafts.delete(from); drafts.set(to, d); dirty.delete(from); const k = storeKey(from); if (k) safe(() => localStorage.removeItem(k), undefined); write(to); notify();
}
/** Forget what is in memory (auth lost, account switch). Stored text stays for the same user's next sign-in. */
export function resetDrafts() { flushDrafts(); generation++; drafts.forEach(abortUploads); drafts.clear(); notify(); }
/** Sign-out: also delete every stored draft of this user from this browser. */
export function wipeDrafts() {
  if (timer) clearTimeout(timer); timer = undefined; dirty.clear();
  const prefix = scope ? `${PREFIX}${scope}:` : PREFIX;
  safe(() => { for (const k of Object.keys(localStorage)) if (k.startsWith(prefix)) localStorage.removeItem(k); }, undefined);
  resetDrafts();
}
if (typeof addEventListener === 'function') { addEventListener('pagehide', flushDrafts); addEventListener('visibilitychange', () => { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flushDrafts(); }); }

export function useDraft(key: string): [Draft, (update: Update) => void] {
  const [, bump] = useState(0);
  useLayoutEffect(() => {
    const changed = () => bump((n) => n + 1);
    subscribers.add(changed);
    return () => { subscribers.delete(changed); };
  }, [key]);
  const currentGeneration = generation;
  return [read(key) ?? empty, (update) => {
    // Uploads or image processing started before sign-out must not restore the old account's draft.
    if (currentGeneration !== generation) return;
    const draft = typeof update === 'function' ? update(read(key) ?? empty) : update;
    if (draft.text || draft.pending.length) drafts.set(key, draft); else drafts.delete(key);
    if (draft.text.trim()) schedule(key); else { dirty.delete(key); write(key); } // clearing (send, delete) is immediate, typing is debounced
    notify();
  }];
}
