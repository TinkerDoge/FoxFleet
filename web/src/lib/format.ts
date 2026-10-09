/** Short relative time ("just now", "5 min ago", "3 h ago", "2 d ago"); `at` is epoch milliseconds. */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; return `${Math.round(s / 86400)} d ago`;
}
/** "in 3 days" / "in 5 h" for an expiry; "expired" when past. */
export function until(at: number, now = Date.now()): string {
  const s = Math.round((at - now) / 1000); if (s <= 0) return 'expired';
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))} min`; if (s < 86400) return `in ${Math.round(s / 3600)} h`; return `in ${Math.round(s / 86400)} d`;
}
