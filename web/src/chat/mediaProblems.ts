/** Why a media card could not load. Mirrors android MediaProblems.kt; both are checked against contract/media-problems.vectors.json. */
export type MediaProblemKind = 'outside' | 'denied' | 'missing' | 'too_big' | 'type' | 'rate' | 'machine_offline' | 'hub_too_old' | 'not_offered' | 'no_connector' | 'auth_expired' | 'hub_unreachable' | 'expired' | 'generic';
export interface MediaProblemInput { status?: number; code?: string; message?: string; network?: boolean }

export function mediaProblem(i: MediaProblemInput): MediaProblemKind {
  if (i.network) return 'hub_unreachable';
  const s = i.status ?? 0, c = i.code ?? '', m = (i.message ?? '').toLowerCase();
  if (s === 401) return 'auth_expired';
  if (c === 'outside') return 'outside';
  if (c === 'denied') return 'denied';
  if (c === 'missing') return 'missing';
  if (c === 'too_big' || s === 413) return 'too_big';
  if (c === 'type' || c === 'sniff' || s === 415) return 'type';
  if (c === 'rate' || s === 429) return 'rate';
  if (s === 410) return 'expired';
  if (s === 503 || s === 504) return 'machine_offline';
  if (s === 404) return m.includes('not offered') ? 'not_offered' : m.includes('cannot deliver local') ? 'no_connector' : m === 'not found' || m === '' ? 'hub_too_old' : 'not_offered';
  return 'generic';
}
/** The folder a one-tap fix should share: the file's own directory. */
export const dirOfRef = (ref: string) => { const i = Math.max(ref.lastIndexOf('/'), ref.lastIndexOf('\\')); return i > 0 ? ref.slice(0, i) : ''; };
export const allowCommand = (ref: string) => { const d = dirOfRef(ref); return d && !/^https?:/i.test(ref) ? `foxfleet connector allow-media "${d}"` : ''; };
