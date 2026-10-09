import en from './en.json';

export type Key = keyof typeof en;
/** Look up a UI string; `{name}` placeholders are filled from `vars`. All UI text goes through this (i18n-ready). */
export function t(key: Key, vars?: Record<string, string | number>): string {
  let s: string = en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
