import { draftKey, flushDrafts } from '../src/chat/drafts';
// Test helper: the unsent text stored for a conversation (drafts live in memory + localStorage).
export function useDraftForTest(agent: string, session?: string): string {
  flushDrafts(); const k = draftKey(agent, session);
  for (const key of Object.keys(localStorage)) if (key.endsWith(k)) return localStorage.getItem(key) ?? '';
  return '';
}
