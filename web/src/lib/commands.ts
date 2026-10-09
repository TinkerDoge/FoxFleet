export type LocalCommand = 'new' | 'sessions' | 'stop';
export interface Suggestion { insert: string; label: string; hint: string; local?: LocalCommand }

export const HERMES_COMMANDS: Suggestion[] = [
  { insert: '/new', label: '/new', hint: 'Start a new conversation', local: 'new' },
  { insert: '/sessions', label: '/sessions', hint: 'Open recent sessions', local: 'sessions' },
  { insert: '/stop', label: '/stop', hint: 'Stop the current reply', local: 'stop' },
  { insert: '/btw ', label: '/btw', hint: 'Side question without interrupting' },
  { insert: '/bg ', label: '/bg', hint: 'Run a prompt in a background session' },
  { insert: '/usage', label: '/usage', hint: 'Token usage for this session' },
  { insert: '/reasoning ', label: '/reasoning', hint: 'Change reasoning effort or show/hide' },
  { insert: '/title ', label: '/title', hint: 'Name this session' },
  { insert: '/rollback', label: '/rollback', hint: 'List or restore file checkpoints' },
  { insert: '/help', label: '/help', hint: "List the agent's commands" },
];

/**
 * Suggestions for the token being typed: `/` offers commands plus skills as `/<skill>`, `#` offers skills.
 * Only while the token is the first word (no space or newline yet). Other agent kinds get only the local commands.
 */
export function commandSuggestions(input: string, skills: string[], limit = 8, agentCommands = true): Suggestion[] {
  if (!input || /[\s]/.test(input)) return [];
  const q = input.slice(1).toLowerCase();
  if (input[0] === '/') {
    const cmds = HERMES_COMMANDS.filter((c) => (agentCommands || c.local) && c.label.slice(1).startsWith(q));
    const sk = skills.filter((s) => s.toLowerCase().startsWith(q)).map((s) => ({ insert: `/${s} `, label: `/${s}`, hint: 'Skill' }));
    const seen = new Set<string>();
    return [...cmds, ...sk].filter((s) => (seen.has(s.label) ? false : (seen.add(s.label), true))).slice(0, limit);
  }
  if (input[0] === '#') {
    return skills.filter((s) => s.toLowerCase().includes(q)).sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)))
      .map((s) => ({ insert: `#${s} `, label: `#${s}`, hint: 'Skill' })).slice(0, limit);
  }
  return [];
}

/** Exact local command typed and sent (e.g. "/new"), if any. */
export function localCommandFor(text: string): LocalCommand | undefined {
  return HERMES_COMMANDS.find((c) => c.local && c.label === text.trim())?.local;
}
