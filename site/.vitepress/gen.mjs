// Generates the pages that must never drift from the code. Run by `npm run build`/`dev`.
//   theme/tokens.generated.css  <- design/tokens.json
//   reference/api.md            <- contract/openapi.json
//   hosting/environment.md      <- process.env.* found in server/ and connector/ (+ descriptions below)
//   reference/errors.md         <- fault(status, 'message') calls in server/*.js
//   project/roadmap.md          <- JSON block in docs/roadmap.html
//   theme/roadmap.generated.json <- the same roadmap data, checked against version and provider kinds
// All outputs are gitignored.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateRoadmap } from './roadmap.mjs';

const here = dirname(fileURLToPath(import.meta.url)), site = resolve(here, '..'), root = resolve(site, '..');
const out = (rel, text) => { const f = resolve(site, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/</g, '&lt;');

// ---- tokens -> CSS (VitePress variables + brand) ----
const t = JSON.parse(readFileSync(resolve(root, 'design/tokens.json'), 'utf8'));
const ember = t.accents.find((a) => a.id === 'ember'), L = t.colors.light, D = t.colors.dark;
const hex = (c) => c.length === 9 ? c.slice(0, 7) : c;
writeFileSync(resolve(here, 'theme/tokens.generated.css'), `/* GENERATED from design/tokens.json by gen.mjs. Do not edit. */
:root{--ff-bg:${L.bg};--ff-surface:${L.surface};--ff-alt:${L.surfaceAlt};--ff-text:${L.text};--ff-muted:${L.textMuted};--ff-accent:${ember.light};--ff-danger:${L.danger};--ff-r-card:${t.radius.card}px;--ff-r-control:${t.radius.control}px;--ff-r-small:${t.radius.small}px;--ff-font:${t.type.family};--ff-mono:${t.type.mono}}
.dark{--ff-bg:${D.bg};--ff-surface:${D.surface};--ff-alt:${D.surfaceAlt};--ff-text:${D.text};--ff-muted:${D.textMuted};--ff-accent:${ember.dark};--ff-danger:${D.danger}}
`);

// ---- OpenAPI -> api.md ----
const api = JSON.parse(readFileSync(resolve(root, 'contract/openapi.json'), 'utf8'));
const refName = (s) => s?.$ref ? s.$ref.split('/').pop() : null;
function typeOf(s) {
  if (!s) return '';
  if (s.$ref) return `[${refName(s)}](#schema-${refName(s).toLowerCase()})`;
  if (s.enum) return s.enum.map((e) => `\`${e}\``).join(' \\| ');
  if (s.type === 'array') return `${typeOf(s.items)}[]`;
  if (Array.isArray(s.type)) return s.type.join(' \\| ');
  return s.type || (s.oneOf ? s.oneOf.map(typeOf).join(' \\| ') : 'any');
}
let md = `---\ntitle: REST API\noutline: [2,3]\n---\n\n# REST API\n\n> Generated from [\`contract/openapi.json\`](https://github.com/TinkerDoge/FoxFleet/blob/main/contract/openapi.json) (OpenAPI ${api.openapi}, API version ${api.info.version}) at build time. ${api.info.description}\n\n`;
md += `**Authentication.** ${api.components.securitySchemes.session.description} Mutating requests with a cookie session are checked for a trusted Origin (CSRF). Errors always have the shape \`{ "error": "message" }\`; see [Error codes](./errors).\n\n`;
const byTag = {};
for (const [p, ops] of Object.entries(api.paths)) for (const [m, op] of Object.entries(ops)) (byTag[op.tags?.[0] ?? 'other'] ??= []).push({ p, m: m.toUpperCase(), op });
for (const [tag, list] of Object.entries(byTag)) {
  md += `## ${tag}\n\n`;
  for (const { p, m, op } of list) {
    const open = op.security && op.security.length === 0;
    md += `### \`${m} ${p}\`\n\n${op.summary}${open ? ' *(no sign-in needed)*' : ''}\n\n`;
    const rb = op.requestBody?.content?.['application/json']?.schema;
    if (rb) md += `Request body: ${typeOf(rb)}\n\n`;
    else if (op.requestBody) md += `Request body: ${Object.keys(op.requestBody.content).join(', ')}\n\n`;
    if (op.parameters?.length) md += `Parameters: ${op.parameters.map((x) => `\`${x.name}\` (${x.in}${x.required ? ', required' : ''})`).join(', ')}\n\n`;
    const rs = Object.entries(op.responses).map(([c, r]) => { const s = r.content?.['application/json']?.schema; const d = r.$ref ? refName(r) : r.description; return `\`${c}\` ${esc(d)}${s ? ' → ' + typeOf(s) : ''}`; });
    md += `Responses: ${rs.join('; ')}\n\n`;
  }
}
md += `## Schemas\n\n`;
for (const [name, s] of Object.entries(api.components.schemas)) {
  md += `### Schema: ${name} {#schema-${name.toLowerCase()}}\n\n`;
  if (s.description) md += `${s.description}\n\n`;
  if (s.properties) {
    md += `| Field | Type | Required |\n| --- | --- | --- |\n`;
    for (const [k, v] of Object.entries(s.properties)) md += `| \`${k}\` | ${typeOf(v)} | ${(s.required ?? []).includes(k) ? 'yes' : ''} |\n`;
    md += '\n';
  } else md += `Type: ${typeOf(s)}\n\n`;
}
out('reference/api.md', md);

// ---- environment variables ----
const ENV = {
  FOXFLEET_HOST: ['Address the hub binds to. A non-loopback value turns on the first-run setup code.', '`127.0.0.1` (Docker image: `0.0.0.0`)', 'hub'],
  FOXFLEET_PORT: ['TCP port; takes precedence over `PORT`.', '`3080`', 'hub'],
  PORT: ['TCP port (conventional name; used by the systemd unit and Docker image).', '`3080`', 'hub'],
  FOXFLEET_CONFIG: ['Path of the owner’s `config.json`. The data directory is the folder that contains it (accounts, per-user data and inbox live beside it).', '`server/config.json` (unit: `~/.local/share/foxfleet/config.json`, Docker: `/data/config.json`)', 'hub'],
  FOXFLEET_TRUSTED_ORIGINS: ['Comma-separated list of public origins (`https://hub.example.com`), at most 16, no paths or wildcards. Used for the CSRF/Origin check and to decide that cookies get `Secure`.', 'empty (loopback origins only)', 'hub'],
  FOXFLEET_PASSWORD: ['Creates the first owner (`owner`) from this password if no account exists yet. Remove it after first sign-in.', 'unset', 'hub'],
  FOXFLEET_SETUP_CODE: ['Fixes the first-run setup code instead of a random one. Only relevant on non-loopback binds.', 'random, printed to the log', 'hub'],
  FOXFLEET_WEB_DIR: ['Directory with the built web app (also where avatar packs are looked up).', '`web/dist`', 'hub'],
  FOXFLEET_HISTORY_DAYS: ['Default retention (days) of hub-stored chat history for API-key agents; `0` keeps nothing. Owners can change it in the app (`PUT /api/history/settings`).', '`90`', 'hub'],
  FOXFLEET_HUB: ['Hub address for `pair` (same as `--hub`).', 'required for `pair`', 'connector'],
  FOXFLEET_CODE: ['Pairing code for `pair` (same as `--code`).', 'required for `pair`', 'connector'],
  FOXFLEET_ALLOW_INSECURE_HUB: ['Allow plain `http://` to a non-loopback hub. Trusted LAN only.', 'unset', 'connector'],
  MOCK_API_PORT: ['Test helper only (`server/test/mock-hermes.js`).', '-', 'tests'],
  MOCK_DASH_PORT: ['Test helper only (`server/test/mock-hermes.js`).', '-', 'tests'],
};
const found = new Set();
const scan = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { if (e.name === 'node_modules') continue; const f = resolve(dir, e.name); if (e.isDirectory()) scan(f); else if (/\.(js|mjs)$/.test(e.name)) for (const m of readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) found.add(m[1]); } };
scan(resolve(root, 'server')); scan(resolve(root, 'connector'));
const unknown = [...found].filter((v) => !ENV[v]);
if (unknown.length) throw new Error(`gen.mjs: undocumented environment variables in the code: ${unknown.join(', ')}. Add them to ENV in site/.vitepress/gen.mjs.`);
const stale = Object.keys(ENV).filter((v) => !found.has(v));
if (stale.length) throw new Error(`gen.mjs: documented but no longer in the code: ${stale.join(', ')}`);
const table = (who) => `| Variable | Meaning | Default |\n| --- | --- | --- |\n` + Object.entries(ENV).filter(([, v]) => v[2] === who).map(([k, v]) => `| \`${k}\` | ${esc(v[0])} | ${esc(v[1])} |`).join('\n') + '\n';
out('hosting/environment.md', `# Environment variables\n\n::: info Generated\nThe list of variables is scanned from \`process.env.*\` in \`server/\` and \`connector/\` at build time; the build fails if the code gains a variable that is not described here.\n:::\n\n## Hub\n\n${table('hub')}\nSet them in \`~/.config/foxfleet/env\` (systemd, see [Linux with systemd](./systemd)), in \`.env\` next to \`compose.yaml\` (Docker), or in your shell.\n\n## Connector\n\n${table('connector')}\n## Tests only\n\n${table('tests')}\nThe deploy script has its own settings (\`FOXFLEET_SRC\`, \`FOXFLEET_DATA\`, \`FOXFLEET_HEALTH\`, \`FOXFLEET_UNIT\`, \`FOXFLEET_BACKUPS\`, \`FOXFLEET_SKIP_WEB\`, \`NODE\`, \`NPM\`): see [Upgrading and rollback](./upgrading).\n`);

// ---- error codes ----
const errs = new Map();
for (const f of readdirSync(resolve(root, 'server')).filter((n) => n.endsWith('.js'))) for (const m of readFileSync(resolve(root, 'server', f), 'utf8').matchAll(/fault\((\d{3}), '((?:[^'\\]|\\.)+)'/g)) (errs.get(+m[1]) ?? errs.set(+m[1], new Set()).get(+m[1])).add(m[2]);
const names = { 400: 'Bad request: the input was rejected', 401: 'Not signed in or bad credentials', 403: 'Signed in but not allowed (or a check failed)', 404: 'Unknown thing', 405: 'Wrong HTTP method', 409: 'Conflict', 413: 'Too large', 429: 'Rate limited or locked out', 500: 'Server problem', 502: 'The upstream agent failed', 503: 'Not available right now' };
let e = `# Error codes\n\nEvery error response is JSON: \`{ "error": "<message>" }\` with one of these HTTP statuses. Messages never contain hosts, URLs or secrets. The table below is scanned from the \`fault(status, message)\` calls in \`server/*.js\` at build time.\n\n`;
for (const [s, set] of [...errs].sort((a, b) => a[0] - b[0])) e += `## ${s} ${names[s] ?? ''}\n\n${[...set].sort().map((m) => `- ${m.replace(/\\'/g, "'")}`).join('\n')}\n\n`;
out('reference/errors.md', e);

// ---- roadmap ----
generateRoadmap(root, out);
// Licence text for the bundled Inter font, published with the site.
mkdirSync(resolve(site, 'public/licenses'), { recursive: true });
copyFileSync(resolve(root, 'LICENSES/Inter-OFL-1.1.txt'), resolve(site, 'public/licenses/Inter-OFL-1.1.txt'));
console.log('docs: generated tokens css, api, environment, errors, roadmap');
