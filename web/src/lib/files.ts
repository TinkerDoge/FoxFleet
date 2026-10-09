export const MAX_FILE_BYTES = 90 * 1024 * 1024;
export interface FileRef { name: string; path: string; size: number }

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB']; let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
const LINE = /^\[Attached file: (.+) \(([^()]+)\)\]$/;
export const fileMarker = (f: FileRef) => `[Attached file: ${f.path} (${humanSize(f.size)})]`;
export const composeWithFiles = (text: string, files: FileRef[]) => files.length ? [text, ...files.map(fileMarker)].filter((x, i) => i > 0 || x.trim()).join('\n\n') : text;
/** Splits a user message into its text and the (path, size) of each attached file. */
export function splitFiles(text: string): { text: string; files: { path: string; size: string }[] } {
  const files: { path: string; size: string }[] = [], rest: string[] = [];
  for (const l of text.split('\n')) { const m = LINE.exec(l.trim()); if (m) files.push({ path: m[1], size: m[2] }); else rest.push(l); }
  return { text: rest.join('\n').trim(), files };
}
