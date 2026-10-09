import bundled from '../data/hermes-commands.json';

/** Commands Foxfleet runs itself: new chat, history, stop, retry the last message, rename the session. */
export type LocalCommand = 'new' | 'sessions' | 'stop' | 'retry' | 'title';
export type Availability = 'app' | 'chat' | 'unavailable';
export interface CatalogCommand { name: string; aliases: string[]; description: string; category: string; args: string; subcommands: string[]; availability: Availability; app?: string; reason?: string; handler?: string; busy?: string; executable?: boolean; disabledReason?: string; verified?: boolean; unavailableSubcommands?: Record<string, string> }
export interface Catalog { source?: string; busy?: string[]; commands: CatalogCommand[]; skills?: string[]; warning?: string }
export interface Suggestion { insert: string; label: string; hint: string; local?: LocalCommand; group?: string; args?: string; availability?: Availability; reason?: string; kind?: 'arg'; alias?: boolean }

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
const ORDER = ['Session', 'Skills', 'Configuration', 'Info', 'Tools & Skills', 'Context', 'Background & Automation', 'Plugins', 'Exit'];

export function toSuggestions(cat: Catalog): Suggestion[] {
  const out: Suggestion[] = [];
  for (const c0 of cat.commands) {
    const c: CatalogCommand = c0.executable === false ? { ...c0, availability: 'unavailable', reason: c0.disabledReason ?? c0.reason } : /^hub:(queue|steer|busy)$/.test(c0.handler ?? '') ? { ...c0, availability: 'chat' } : c0;
    const names = [c.name, ...c.aliases];
    const local = c.availability === 'app' ? (names.map((n) => APP_LOCAL[n]).find(Boolean) as LocalCommand | undefined) : undefined;
    for (const n of names) {
      if (c.availability === 'app' && !APP_LOCAL[n]) continue;
      out.push({ insert: `/${n}${c.args ? ' ' : ''}`, label: `/${n}`, hint: c.availability === 'unavailable' ? `${c.description} · ${c.reason ?? 'Not available remotely'}` : c.description, group: c.category, args: c.args || undefined, availability: c.availability, reason: c.reason, alias: n !== c.name, ...(local && APP_LOCAL[n] ? { local: APP_LOCAL[n] } : {}) });
    }
  }
  return out.sort((a, b) => (ORDER.indexOf(a.group!) + 1 || 99) - (ORDER.indexOf(b.group!) + 1 || 99) || RANK[a.availability!] - RANK[b.availability!] || a.label.localeCompare(b.label));
}
const BUNDLED_SUGGESTIONS = toSuggestions(BUNDLED_CATALOG);

/**
 * Suggestions for the token being typed: `/` offers commands (grouped, with availability) plus skills as `/<skill>`,
 * `#` offers skills. Only while the token is the first word. Agents that are not Hermes get only the local commands.
 */
/** The command a typed name refers to (aliases resolved: "/q" is /queue). */
export const resolveCommand = (name: string, cat: Catalog = BUNDLED_CATALOG): CatalogCommand | undefined => cat.commands.find((c) => [c.name, ...c.aliases].includes(name.toLowerCase()));
/** Second-level choices: "/busy " lists queue, steer, interrupt, status; "/busy st" filters to steer and status. Free text after the choice is left alone. */
export function argSuggestions(input: string, cat: Catalog = BUNDLED_CATALOG): Suggestion[] {
  const m = /^\/([A-Za-z0-9_-]+)\s+(\S*)$/.exec(input); if (!m) return [];
  const c = resolveCommand(m[1], cat); if (!c?.subcommands?.length || c.executable === false) return [];
  const q = m[2].toLowerCase(), more = /<|\bN\b|prompt/.test(c.args);
  const hits = c.subcommands.filter((x) => x.toLowerCase().startsWith(q));
  if (hits.length === 1 && hits[0].toLowerCase() === q) return [];
  return hits.map((x): Suggestion => { const off = c.unavailableSubcommands?.[x]; return { insert: `/${m[1]} ${x}${more && ['add', 'rm', 'edit', 'move'].includes(x) ? ' ' : ''}`, label: x, hint: off ?? '', group: `Choices for /${c.name}`, kind: 'arg', availability: off ? 'unavailable' : 'chat', reason: off }; });
}
const byGroup = (a: Suggestion, b: Suggestion) => (ORDER.indexOf(a.group ?? '') + 1 || 99) - (ORDER.indexOf(b.group ?? '') + 1 || 99) || RANK[a.availability ?? 'chat'] - RANK[b.availability ?? 'chat'] || a.label.localeCompare(b.label);
/** A word in the hint or argument text starts with the query. Used only when no command name matches. */
const wordHit = (text: string, q: string) => text.toLowerCase().split(/[^a-z0-9_+-]+/).some((w) => w.startsWith(q));
/** /help and /palette open Foxfleet's own command browser. They are not sent to the agent. */
export const opensCommandBrowser = (text: string) => /^\/(help|palette)$/i.test(text.trim());
export function commandSuggestions(input: string, skills: string[], limit = 12, agentCommands = true, catalog?: Catalog, includeHidden = false): Suggestion[] {
  if (!input) return [];
  if (/[\s]/.test(input)) return input[0] === '/' && (catalog || agentCommands) ? argSuggestions(input, catalog ?? BUNDLED_CATALOG).slice(0, limit) : [];
  const q = input.slice(1).toLowerCase();
  if (input[0] === '/') {
    const all = catalog ? toSuggestions(catalog) : agentCommands ? BUNDLED_SUGGESTIONS : LOCAL_ONLY;
    const sk = agentCommands && skills.length ? skills.filter((s) => s.toLowerCase().startsWith(q)).map((s): Suggestion => ({ insert: `/${s} `, label: `/${s}`, hint: 'Skill', group: 'Skills', availability: 'chat' })) : [];
    const named = !q ? (includeHidden ? all : all.filter((s) => !s.alias && s.availability !== 'unavailable')) : all.filter((s) => s.label.slice(1).toLowerCase().startsWith(q));
    const text = q.length >= 2 && named.length === 0 ? all.filter((s) => !s.alias && wordHit(`${s.hint} ${s.args ?? ''}`, q)) : [];
    const seen = new Set<string>();
    const rows = [...named, ...sk].sort(byGroup).concat(text).filter((s) => (seen.has(s.label) ? false : (seen.add(s.label), true)));
    return Number.isFinite(limit) ? rows.slice(0, limit) : rows;
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
  const c = resolveCommand(m[1], catalog);
  return c?.executable === false ? c.disabledReason ?? 'Not available remotely' : c?.availability === 'unavailable' ? c.reason ?? 'Not available remotely' : undefined;
}

/** The hub's own busy controls typed in the composer: "/queue text", "/steer text", "/busy steer". Resolved through the catalog so aliases work (/q, /s). */
export type HubCommand = 'queue' | 'steer' | 'busy';
export function parseHub(text: string, cat: Catalog = BUNDLED_CATALOG): { cmd: HubCommand; args: string; command: CatalogCommand } | undefined {
  const m = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim()); if (!m) return undefined;
  const c = resolveCommand(m[1], cat), h = c?.handler?.replace('hub:', '');
  return c && (h === 'queue' || h === 'steer' || h === 'busy') ? { cmd: h, args: (m[2] ?? '').trim(), command: c } : undefined;
}
/** What the composer offers for an agent when the hub's catalog could not be fetched. */
export const LOCAL_CATALOG: Catalog = { source: 'local', commands: [
  { name: 'new', aliases: ['reset'], description: 'Start a new chat', category: 'Session', args: '', subcommands: [], availability: 'app', app: 'new' },
  { name: 'history', aliases: ['sessions', 'resume'], description: 'Browse previous chats', category: 'Session', args: '', subcommands: [], availability: 'app', app: 'history' },
  { name: 'retry', aliases: [], description: 'Send the last message again', category: 'Session', args: '', subcommands: [], availability: 'app', app: 'retry' },
  { name: 'title', aliases: [], description: 'Rename this chat', category: 'Session', args: '[name]', subcommands: [], availability: 'app', app: 'title' },
  { name: 'stop', aliases: [], description: 'Stop the reply that is running', category: 'Session', args: '', subcommands: [], availability: 'app', app: 'stop' },
] };
