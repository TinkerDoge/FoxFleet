// Dev/screenshot helper (not a test): a single-user hub with several agents and seeded last-activity lines, to look at the agent list.
//   node server/test/list-demo-hub.js [webDist]   -> prints the hub URL, runs until killed
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockHermes } from './fixtures.js';
import { createHub } from '../index.js';
const cleanups = [], t = { after: (f) => cleanups.push(f), skip() {} };
const names = [['sumin', 'Sumin', 'Lead agent'], ['samyn', 'Samyn', 'Release engineer'], ['arzyn', 'Arzyn', 'Icon designer'], ['rennyn', 'Rennyn', 'Daily flow'], ['soran', 'Soran', 'Research'], ['roseyn', 'Roseyn', 'Figures'], ['long', 'Doge Studio Operations Night Shift Agent', 'A very long agent name to test ellipsis']];
const conns = []; for (const [i, [name, label, description]] of names.entries()) { const m = await mockHermes(t); conns.push({ ...m.connection, name, label, description }); if (i === 5) await m.dispose?.(); }
const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-list-demo-')), now = Date.now(), min = 60_000, H = 60 * min, D = 24 * H;
await writeFile(path.join(dir, 'config.json'), JSON.stringify({ machines: conns }));
const act = (at, role, preview, title = '') => ({ at, role, preview, title, session: null });
await writeFile(path.join(dir, 'activity.json'), JSON.stringify({ version: 1, pins: ['sumin'], agents: {
  sumin: act(now - 3 * min, 'assistant', 'FoxFleet 0.3.3-alpha is released, merged and cleaned up. CI is green and the docs site shows the new version.', 'Release'),
  samyn: act(now - 12 * min, 'assistant', 'FoxFleet v0.3.3-alpha is published as a pre-release with the signed APK', 'Publishing'),
  arzyn: act(now - 20 * H, 'user', 'The wooden fox icons are ready to review'), rennyn: act(now - 3 * D, 'assistant', 'Paused. The daily Flow batch stays off until you say so.'),
  soran: act(now - 6 * D, 'user', 'Soran here. The v0.5 Android build is green'), roseyn: act(now - 40 * D, 'assistant', 'The SUMI figure brief is done and with Sumin'), long: act(now - 2 * H, 'assistant', 'Night shift summary: 3 jobs ran, 1 needs a look in the morning.'),
} }));
const server = await createHub({ configPath: path.join(dir, 'config.json'), singleUser: true });
await new Promise((r) => server.listen(Number(process.env.PORT) || 0, '127.0.0.1', r));
console.log('HUB http://127.0.0.1:' + server.address().port);
process.on('SIGTERM', async () => { for (const f of cleanups.reverse()) await f(); process.exit(0); });
setInterval(() => {}, 1 << 30);
