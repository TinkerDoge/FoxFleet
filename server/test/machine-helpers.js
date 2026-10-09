// Shared helpers: a fake Hermes home with several profiles, and spawning the REAL connector against a hub.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CONNECTOR = path.join(import.meta.dirname, '..', '..', 'connector', 'foxfleet-connector.mjs');

// Layout copied from hermes-agent: root = default profile, <root>/profiles/<id> named ones, a marker file makes it a profile,
// <root>/profiles/.deleted/<id> is a tombstone. Secrets live in each profile's own .env, exactly where Hermes keeps them.
export async function fakeHermesHome(t, mock, { profiles = ['coder', 'sumi'], extra = {} } = {}) {
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
  t.after(() => p.kill());
  return { p, get out() { return out; }, done: new Promise((r) => p.on('exit', (code) => r(code))) };
}
export const tmpDir = (prefix = 'ff-cfg-') => mkdtemp(path.join(os.tmpdir(), prefix));
export const readJson = async (f) => JSON.parse(await readFile(f, 'utf8'));
export async function waitFor(fn, { tries = 60, ms = 150 } = {}) { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, ms)); } return null; }
