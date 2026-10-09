import bundled from '../data/hermes-commands.json';

/** Commands Foxfleet runs itself: new chat, history, stop, retry the last message, rename the session. */
export type LocalCommand = 'new' | 'sessions' | 'stop' | 'retry' | 'title';
export type Availability = 'app' | 'chat' | 'unavailable';
export interface CatalogCommand { name: string; aliases: string[]; description: string; category: string; args: string; subcommands: string[]; availability: Availability; app?: string; reason?: string }
export interface Catalog { source?: string; commands: CatalogCommand[] }
export interface Suggestion { insert: string; label: string; hint: string; local?: LocalCommand; group?: string; args?: string; availability?: Availability; reason?: string }

/** The bundled list (generated from hermes-agent's command registry by design/tools/gen-hermes-commands.py); the hub may serve a fresher one. */
export const BUNDLED_CATALOG: Catalog = { source: 'bundled', commands: (bundled as { commands: CatalogCommand[] }).commands };
const APP_LOCAL: Record<string, LocalCommand> = { new: 'new', reset: 'new', history: 'sessions', resume: 'sessions', sessions: 'sessions', stop: 'stop', retry: 'retry', title: 'title' };
/** Always available, for every agent kind: they act on the conversation in the app, not on the agent. */
const LOCAL_ONLY: Suggestion[] = [
  { insert: '/new', label: '/new', hint: 'Start a new conversation', local: 'new', group: 'Chat', availability: 'app' },
  { insert: '/sessions', label: '/sessions', hint: 'Open history', local: 'sessions', group: 'Chat', availability: 'app' },
  { insert: '/stop', label: '/stop', hint: 'Stop the current reply', local: 'stop', group: 'Chat', availability: 'app' },
];
const RANK = { app: 0, chat: 1, unavailable: 2 };
const ORDER = ['Session', 'Configuration', 'Info', 'Tools & Skills', 'Context', 'Background & Automation', 'Plugins', 'Exit'];

export function toSuggestions(cat: Catalog): Suggestion[] {
  const out: Suggestion[] = [];
  for (const c of cat.commands) {
    const names = [c.name, ...c.aliases];
    const local = c.availability === 'app' ? (names.map((n) => APP_LOCAL[n]).find(Boolean) as LocalCommand | undefined) : undefined;
    for (const n of names) {
      if (c.availability === 'app' && !APP_LOCAL[n]) continue;
      out.push({ insert: `/${n}${c.args ? ' ' : ''}`, label: `/${n}`, hint: c.availability === 'unavailable' ? `${c.description} · ${c.reason ?? 'Not available remotely'}` : c.description, group: c.category, args: c.args || undefined, availability: c.availability, reason: c.reason, ...(local && APP_LOCAL[n] ? { local: APP_LOCAL[n] } : {}) });
    }
  }
  return out.sort((a, b) => (ORDER.indexOf(a.group!) + 1 || 99) - (ORDER.indexOf(b.group!) + 1 || 99) || RANK[a.availability!] - RANK[b.availability!] || a.label.localeCompare(b.label));
}
const BUNDLED_SUGGESTIONS = toSuggestions(BUNDLED_CATALOG);

/**
 * Suggestions for the token being typed: `/` offers commands (grouped, with availability) plus skills as `/<skill>`,
 * `#` offers skills. Only while the token is the first word. Agents that are not Hermes get only the local commands.
 */
export function commandSuggestions(input: string, skills: string[], limit = 12, agentCommands = true, catalog?: Catalog): Suggestion[] {
  if (!input || /[\s]/.test(input)) return [];
  const q = input.slice(1).toLowerCase();
  if (input[0] === '/') {
    const all = agentCommands ? (catalog ? toSuggestions(catalog) : BUNDLED_SUGGESTIONS) : LOCAL_ONLY;
    const cmds = all.filter((c) => c.label.slice(1).startsWith(q));
    const sk = agentCommands ? skills.filter((s) => s.toLowerCase().startsWith(q)).map((s): Suggestion => ({ insert: `/${s} `, label: `/${s}`, hint: 'Skill', group: 'Skills', availability: 'chat' })) : [];
    const seen = new Set<string>();
    return [...cmds, ...sk].filter((s) => (seen.has(s.label) ? false : (seen.add(s.label), true))).slice(0, limit);
  }
  if (input[0] === '#' && agentCommands) {
    return skills.filter((s) => s.toLowerCase().includes(q)).sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)))
      .map((s): Suggestion => ({ insert: `#${s} `, label: `#${s}`, hint: 'Skill', group: 'Skills', availability: 'chat' })).slice(0, limit);
  }
  return [];
}

/** "/new", "/title My plan": a command Foxfleet runs itself, with its argument text. */
export function parseLocal(text: string, agentCommands = true): { cmd: LocalCommand; args: string } | undefined {
  const m = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim()); if (!m) return undefined;
  const name = m[1].toLowerCase(), args = (m[2] ?? '').trim();
  const direct = LOCAL_ONLY.find((c) => c.label === `/${name}`); if (direct) return args ? undefined : { cmd: direct.local!, args };
  if (!agentCommands) return undefined;
  const c = BUNDLED_CATALOG.commands.find((x) => x.availability === 'app' && [x.name, ...x.aliases].includes(name));
  const cmd = c && APP_LOCAL[name]; if (!cmd) return undefined;
  return cmd === 'title' ? (args ? { cmd, args } : undefined) : args ? undefined : { cmd, args };
}
/** Exact local command typed and sent (e.g. "/new"), if any. */
export const localCommandFor = (text: string, agentCommands = true): LocalCommand | undefined => parseLocal(text, agentCommands)?.cmd;

/** A command that exists in Hermes but cannot run from a phone or browser: "/clear" → the reason, else undefined. */
export function unavailableReason(text: string, catalog: Catalog = BUNDLED_CATALOG): string | undefined {
  const m = /^\/([A-Za-z0-9_-]+)/.exec(text.trim()); if (!m) return undefined;
  const c = catalog.commands.find((x) => [x.name, ...x.aliases].includes(m[1].toLowerCase()));
  return c?.availability === 'unavailable' ? c.reason ?? 'Not available remotely' : undefined;
}
