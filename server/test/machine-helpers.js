// Shared helpers: a fake Hermes home with several profiles, and spawning the REAL connector against a hub.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CONNECTOR = path.join(import.meta.dirname, '..', '..', 'connector', 'foxfleet-connector.mjs');

// Layout copied from hermes-agent: root = default profile, <root>/profiles/<id> named ones, a marker file makes it a profile,
// <root>/profiles/.deleted/<id> is a tombstone. Secrets live in each profile's own .env, exactly where Hermes keeps them.
export async function fakeHermesHome(t, mock, { profiles = ['coder', 'research'], extra = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ff-hermes-')), env = (ports = mock.connection) => `API_SERVER_PORT=${ports.apiServerPort}\nAPI_SERVER_KEY=api-secret\nHERMES_DASHBOARD_BASIC_AUTH_USERNAME=admin\nHERMES_DASHBOARD_BASIC_AUTH_PASSWORD=dashboard-secret\n`;
  await writeFile(path.join(root, '.env'), env()); await writeFile(path.join(root, 'config.yaml'), 'model: x\n');
  for (const n of profiles) { await mkdir(path.join(root, 'profiles', n), { recursive: true }); await writeFile(path.join(root, 'profiles', n, '.env'), extra[n] ?? env()); }
  await mkdir(path.join(root, 'profiles', 'ghost'), { recursive: true });                       // no marker: not a profile
  await mkdir(path.join(root, 'profiles', 'Bad_Name'), { recursive: true }); await writeFile(path.join(root, 'profiles', 'Bad_Name', '.env'), 'x=1\n'); // invalid id
  await mkdir(path.join(root, 'profiles', 'old'), { recursive: true }); await writeFile(path.join(root, 'profiles', 'old', '.env'), 'x=1\n');
  await mkdir(path.join(root, 'profiles', '.deleted'), { recursive: true }); await writeFile(path.join(root, 'profiles', '.deleted', 'old'), '');
  return root;
}

export function runConnector(t, args, { hermes, configDir, env = {} } = {}) {
  const p = spawn(process.execPath, ['--experimental-websocket', CONNECTOR, ...args], { env: { ...process.env, FOXFLEET_CONFIG_DIR: configDir, FOXFLEET_HERMES_HOME: hermes, FOXFLEET_ALLOW_INSECURE_HUB: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { out += c; });
  const done = new Promise((r) => p.on('close', (code) => r(code)));
  // Teardown must not return until the child is really gone (and its pipes closed), or a slow exit keeps the test process alive: SIGTERM, then SIGKILL after 2s.
  t.after(async () => { if (p.exitCode !== null || p.signalCode) return; p.kill(); const k = setTimeout(() => p.kill('SIGKILL'), 2000); await done; clearTimeout(k); });
  return { p, get out() { return out; }, done };
}
export const tmpDir = (prefix = 'ff-cfg-') => mkdtemp(path.join(os.tmpdir(), prefix));
export const readJson = async (f) => JSON.parse(await readFile(f, 'utf8'));
export async function waitFor(fn, { tries = 60, ms = 150 } = {}) { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, ms)); } return null; }

/** Child output arrives asynchronously: wait (with a timeout) for a line instead of asserting on it the moment some other signal is seen. Returns the matching output or null. */
export const waitOut = (run, re, opts = { tries: 100, ms: 100 }) => waitFor(async () => (re.test(run.out) ? run.out : null), opts);
