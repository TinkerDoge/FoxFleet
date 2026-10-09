// Schema-driven agent forms: the hub describes each kind (GET /api/agent-kinds); nothing here is hardcoded per provider.
export interface KindField {
  key: string; label: string; type: string; required: boolean; writeOnly: boolean; default?: string; advanced: boolean; help?: string;
  options: string[]; whenKey?: string; whenValue?: string;
}
export interface AgentKind { kind: string; label: string; summary: string; planned: boolean; fields: KindField[]; auth: string[]; warnings: string[] }
export interface SavedAgent { name: string; kind: string; values: Record<string, string>; saved: string[] }
export interface CheckResult { ok: boolean; message: string }
export interface TestResult { ok: boolean; checks: [string, CheckResult][] }
export interface SaveResult { agent: SavedAgent; inboxToken?: string }
export type Form = Record<string, string>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function parseKinds(o: any): AgentKind[] {
  return (Array.isArray(o?.kinds) ? o.kinds : []).map((k: any): AgentKind => ({
    kind: str(k.kind) ?? '?', label: str(k.label) ?? '?', summary: str(k.summary) ?? '', planned: k.planned === true, auth: strs(k.auth), warnings: strs(k.warnings),
    fields: (Array.isArray(k.fields) ? k.fields : []).map((f: any): KindField => {
      const when = f.when && typeof f.when === 'object' ? Object.entries(f.when)[0] : undefined;
      return { key: str(f.key) ?? '', label: str(f.label) ?? '', type: str(f.type) ?? 'text', required: f.required === true, writeOnly: f.writeOnly === true,
        default: str(f.default), advanced: f.advanced === true, help: str(f.help), options: strs(f.options), whenKey: when?.[0], whenValue: when ? String(when[1]) : undefined };
    }),
  }));
}
/** A saved agent as the owner sees it: plain values plus `hasX` flags for write-only fields (never the secret itself). */
export function parseSaved(o: any): SavedAgent {
  const values: Record<string, string> = {}, saved: string[] = [];
  for (const [k, v] of Object.entries(o ?? {})) {
    if (/^has[A-Z]/.test(k)) { if (v === true) saved.push(k[3].toLowerCase() + k.slice(4)); continue; }
    if (k === 'name' || k === 'kind') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') values[k] = String(v);
  }
  return { name: str(o?.name) ?? '?', kind: str(o?.kind) ?? 'hermes', values, saved };
}
export function parseTest(o: any): TestResult {
  const checks = Object.entries(o?.checks ?? {}).map(([k, v]: [string, any]): [string, CheckResult] => [k, { ok: v?.ok === true, message: scrubAddresses(str(v?.message) ?? '') }]);
  return { ok: typeof o?.ok === 'boolean' ? o.ok : checks.every(([, c]) => c.ok), checks };
}

export const isEnum = (f: KindField) => f.type === 'enum' && f.options.length > 0;
export const isSecret = (f: KindField) => f.type === 'secret';
export function visible(f: KindField, form: Form, kind: AgentKind): boolean {
  if (!f.whenKey) return true;
  const current = form[f.whenKey]?.trim() || kind.fields.find((x) => x.key === f.whenKey)?.default;
  return current === f.whenValue;
}

/**
 * JSON fields to send. On edit, blank write-only fields are omitted so the hub keeps the saved value;
 * blank plain fields are sent as "" (clears them). Ports are numbers. Hidden (conditional) fields are never sent.
 */
export function payload(kind: AgentKind, form: Form, editing: boolean): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!editing) out.kind = kind.kind;
  for (const f of kind.fields) {
    if (editing && f.key === 'name') continue;
    if (!visible(f, form, kind)) continue;
    const v = (form[f.key] ?? '').trim();
    if (!v) { if (isEnum(f) && !editing && f.default) out[f.key] = f.default; else if (!f.writeOnly && editing) out[f.key] = ''; continue; }
    out[f.key] = f.type === 'port' ? (Number.isInteger(Number(v)) ? Number(v) : v) : v;
  }
  return out;
}
/** First problem with a form, or undefined when it can be sent. */
export function validate(kind: AgentKind, form: Form, editing: boolean, existing?: SavedAgent): string | undefined {
  for (const f of kind.fields) {
    if (!visible(f, form, kind)) continue;
    const v = (form[f.key] ?? '').trim();
    if (f.key === 'name' && !editing && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v)) return 'ID: letters, digits, . _ - (up to 64)';
    if (f.required && !v && !(editing && (f.key === 'name' || (f.writeOnly && existing?.saved.includes(f.key))))) return `${f.label} is required`;
    if (f.type === 'port' && v && !(Number(v) >= 1 && Number(v) <= 65535)) return `${f.label} must be 1–65535`;
  }
}
export function moved<T>(items: T[], index: number, delta: number): T[] {
  const to = index + delta;
  if (index < 0 || index >= items.length || to < 0 || to >= items.length) return items;
  const next = items.slice(); next.splice(to, 0, next.splice(index, 1)[0]); return next;
}
/** Safety net: never show hosts, IPs or URLs that slipped into an error message. */
export function scrubAddresses(s: string): string {
  return s.replace(/\bhttps?:\/\/\S+/gi, '[hidden]').replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[hidden]').replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:lan|local|internal|home\.arpa|io|com|net|org|dev|app|vn)(?::\d+)?\b/gi, '[hidden]');
}
export const CHECK_LABELS: Record<string, string> = { dashboard: 'Dashboard', management: 'Management', api: 'Chat API', inbox: 'Mailbox', connector: 'Connector' };
