/** "5 min ago", "yesterday", "12 Mar": short, locale-light labels for history rows and message times. */
export function ago(ms: number | undefined, now = Date.now()): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday'; if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(new Date(ms).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) });
}
export const clock = (ms: number | undefined) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '');
