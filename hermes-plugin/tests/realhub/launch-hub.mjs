// REAL FoxFleet hub from the read-only Devin workspace, ephemeral loopback port, integration tests only.
// Usage: node launch-hub.mjs <serverDir> <configPath> <botOptionsJson>
// Prints one JSON line {"port": N} once listening; stops on SIGTERM or when stdin ends.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [serverDir, configPath, botOptionsJson = '{}'] = process.argv.slice(2);
const { createHub } = await import(pathToFileURL(join(serverDir, 'index.js')).href);
const server = await createHub({ configPath, host: '127.0.0.1', botApi: true, botAgents: '*', botOptions: JSON.parse(botOptionsJson), trustedOrigins: '', ownerPassword: '' });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 2000).unref();
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.stdin.on('end', stop);
process.stdin.resume();
console.log(JSON.stringify({ port: server.address().port }));
