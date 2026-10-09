// Per-agent command catalog: the bundled Hermes list plus what THIS agent can really execute.
// handler: where a command runs: hub:* (hub operations), app:* (the client), chat (plain text sent to the agent: unverified, Hermes decides), none.
// busy: how it behaves while a reply is running: control (works at once), detach (client-only, run keeps going), queue (sent as a normal message).
const HUB = {
  stop: { handler: 'hub:stop', busy: 'control' },
  queue: { handler: 'hub:queue', busy: 'control', sub: { edit: 'Editing queued prompts is not available remotely yet', move: 'Reordering queued prompts is not available remotely yet' } },
  steer: { handler: 'hub:steer', busy: 'control' },
  busy: { handler: 'hub:busy', busy: 'control' },
};
const GENERIC = [
  { name: 'new', aliases: ['reset'], description: 'Start a new chat', category: 'Session', args: '', subcommands: [], availability: 'app', app: 'new' },
  { name: 'history', aliases: ['sessions', 'resume'], description: 'Browse previous chats', category: 'Session', args: '', subcommands: [], availability: 'app', app: 'history' },
  { name: 'retry', aliases: [], description: 'Send the last message again', category: 'Session', args: '', subcommands: [], availability: 'app', app: 'retry' },
  { name: 'title', aliases: [], description: 'Rename this chat', category: 'Session', args: '[name]', subcommands: [], availability: 'app', app: 'title' },
  { name: 'stop', aliases: [], description: 'Stop the reply that is running', category: 'Session', args: '', subcommands: [], availability: 'app', app: 'stop' },
  { name: 'queue', aliases: ['q'], description: 'Queue a message for the next turn', category: 'Session', args: '[<prompt>|list|rm N|clear]', subcommands: ['list', 'rm', 'clear', 'add'], availability: 'chat' },
  { name: 'busy', aliases: [], description: 'Choose how messages behave while the agent is replying', category: 'Configuration', args: '[queue|interrupt|status]', subcommands: ['queue', 'interrupt', 'status'], availability: 'app' },
];
export function catalogFor({ kind, bundled, modes }) {
  const base = kind === 'hermes' ? bundled : kind === 'mcp-inbox' ? [] : GENERIC;
  return base.map((c) => {
    const hub = HUB[c.name], out = { ...c };
    if (hub) {
      out.handler = hub.handler; out.busy = hub.busy; out.availability = c.name === 'busy' ? 'app' : c.availability; delete out.reason; delete out.app;
      if (c.name === 'busy') out.subcommands = [...modes.filter((x) => x), 'status'];
      if (c.name === 'steer' && !modes.includes('steer')) { out.executable = false; out.disabledReason = 'This agent has no native steering; use Queue or Interrupt & send'; }
      else out.executable = true;
      if (c.name === 'queue' && kind === 'hermes') { out.subcommands = ['add', 'list', 'rm', 'clear']; out.unavailableSubcommands = hub.sub; }
      if (c.name === 'stop') out.description = 'Stop the reply that is running';
    } else if (c.availability === 'app') { out.handler = `app:${c.app}`; out.busy = 'detach'; out.executable = true; }
    else if (c.availability === 'chat') { out.handler = 'chat'; out.busy = 'queue'; out.executable = true; out.verified = false; }
    else { out.handler = 'none'; out.busy = 'none'; out.executable = false; out.disabledReason = c.reason || 'Not available remotely'; }
    return out;
  });
}
