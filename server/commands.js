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

const SKIP = new Set(['__proto__', 'constructor', 'prototype']);
const clip = (v, n) => String(v ?? '').slice(0, n);
/** One [name, description] pair from a live catalog, or null when it is not a slash name. */
function livePair(p) {
  if (!Array.isArray(p) || typeof p[0] !== 'string' || !p[0].startsWith('/') || p[0].length > 80) return null;
  return [p[0], clip(p[1], 400)];
}
/**
 * The fields Hermes `commands.catalog` returns, reduced to plain data.
 * `skills` keeps the gateway's `{ "/name": { usage, origin } }` shape. `skillNames` is the bare names.
 * A live catalog describes what that profile can see. It does not grant remote execution.
 */
export function readLiveCatalog(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const pairs = (Array.isArray(o.pairs) ? o.pairs : []).map(livePair).filter(Boolean).slice(0, 500);
  const sub = {};
  if (o.sub && typeof o.sub === 'object') for (const [k, v] of Object.entries(o.sub).slice(0, 200)) {
    if (SKIP.has(k) || !Array.isArray(v)) continue;
    sub[clip(k, 80)] = v.filter((x) => typeof x === 'string').slice(0, 40).map((x) => clip(x, 80));
  }
  const canon = {};
  if (o.canon && typeof o.canon === 'object') for (const [k, v] of Object.entries(o.canon).slice(0, 800)) {
    if (SKIP.has(k) || typeof k !== 'string' || typeof v !== 'string' || !k.startsWith('/') || !v.startsWith('/')) continue;
    canon[k.slice(0, 80).toLowerCase()] = v.slice(0, 80);
  }
  const commands = {};
  if (o.commands && typeof o.commands === 'object' && !Array.isArray(o.commands)) for (const [k, v] of Object.entries(o.commands).slice(0, 800)) {
    if (SKIP.has(k) || !k.startsWith('/') || !v || typeof v !== 'object') continue;
    const meta = {};
    for (const [mk, mv] of Object.entries(v).slice(0, 12)) {
      if (SKIP.has(mk)) continue;
      if (typeof mv === 'string') meta[clip(mk, 40)] = clip(mv, 200);
      else if (typeof mv === 'boolean' || mv === null) meta[clip(mk, 40)] = mv;
      else if (Array.isArray(mv) && mv.every((x) => typeof x === 'string')) meta[clip(mk, 40)] = mv.slice(0, 20).map((x) => clip(x, 80));
    }
    commands[k.slice(0, 80)] = meta;
  }
  const categories = (Array.isArray(o.categories) ? o.categories : []).filter((c) => c && typeof c.name === 'string').slice(0, 40).map((c) => ({
    name: clip(c.name, 80), pairs: (Array.isArray(c.pairs) ? c.pairs : []).map(livePair).filter(Boolean).slice(0, 200),
  }));
  const skills = {};
  const src = o.skills && typeof o.skills === 'object' && !Array.isArray(o.skills) ? o.skills : {};
  for (const [k, v] of Object.entries(src).slice(0, 200)) {
    const key = (k.startsWith('/') ? k : `/${k}`).slice(0, 81);
    if (!/^\/[A-Za-z0-9_-]{1,80}$/.test(key)) continue;
    const usage = v && typeof v.usage === 'string' ? clip(v.usage, 200) : '';
    const origin = v && typeof v.origin === 'string' ? clip(v.origin, 40) : '';
    skills[key] = { ...(usage ? { usage } : {}), ...(origin ? { origin } : {}) };
  }
  const skillNames = Object.keys(skills).map((k) => k.slice(1));
  return { pairs, sub, canon, commands, categories, skills, skillNames, skillCount: skillNames.length, warning: typeof o.warning === 'string' ? clip(o.warning, 400) : '' };
}

/** Fold a live catalog onto the bundled command list. New names are visible but not executable: discovery is not permission to run them. */
export function applyLive(commands, live) {
  const known = new Set();
  for (const c of commands) for (const n of [c.name, ...(c.aliases || [])]) known.add(String(n).toLowerCase());
  const skillSet = new Set(live.skillNames.map((s) => s.toLowerCase()));
  const catOf = new Map();
  for (const c of live.categories) for (const [key] of c.pairs) catOf.set(key.replace(/^\//, '').toLowerCase(), c.name);
  const extra = [];
  for (const [key, desc] of live.pairs) {
    const name = key.replace(/^\//, '');
    const low = name.toLowerCase();
    if (!low || known.has(low) || skillSet.has(low)) continue;
    known.add(low);
    extra.push({
      name, aliases: [], description: desc || name, category: catOf.get(low) || 'Plugins', args: '',
      subcommands: live.sub[name] || live.sub[key] || [], availability: 'unavailable', handler: 'none', busy: 'none',
      executable: false, verified: false, reason: 'Not available remotely yet', disabledReason: 'Not available remotely yet',
    });
  }
  return { commands: extra.length ? [...commands, ...extra] : commands, skills: live.skillNames, warning: live.warning };
}
