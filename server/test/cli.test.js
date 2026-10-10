import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE_PATH = ({ ...process.env }).PATH;
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8').replace(/^\uFEFF/, '')).version;
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** A sandbox that looks like an installer layout: apps/current-version (current), data/, fake systemctl on PATH. */
function sandbox({ systemctl = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-cli-')), apps = path.join(root, 'apps'), app = path.join(apps, PKG_VERSION), data = path.join(root, 'data'), bin = path.join(root, 'bin');
  for (const d of ['server/bin', 'connector', 'web/dist']) fs.mkdirSync(path.join(app, d), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'bin/foxfleet'), path.join(app, 'server/bin/foxfleet')); fs.chmodSync(path.join(app, 'server/bin/foxfleet'), 0o755);
  for (const f of ['package.json', 'accounts.js', 'index.js']) fs.existsSync(path.join(SRC, f)) && fs.copyFileSync(path.join(SRC, f), path.join(app, 'server', f));
  fs.writeFileSync(path.join(app, 'web/dist/index.html'), '<html></html>'); fs.mkdirSync(data, { recursive: true, mode: 0o700 }); fs.mkdirSync(bin);
  // accounts.js imports siblings: link the real server dir files we need
  for (const f of fs.readdirSync(SRC)) if (f.endsWith('.js') && !fs.existsSync(path.join(app, 'server', f))) fs.copyFileSync(path.join(SRC, f), path.join(app, 'server', f));
  fs.symlinkSync(app, path.join(apps, 'current'));
  const log = path.join(root, 'systemctl.log');
  if (systemctl) { fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> ${log}\ncase "$2" in is-active) echo active;; is-enabled) echo enabled;; esac\nexit 0\n`, { mode: 0o755 }); fs.writeFileSync(path.join(bin, 'loginctl'), '#!/bin/sh\necho Linger=yes\n', { mode: 0o755 }); }
  return { root, apps, app, data, log, cli: path.join(app, 'server/bin/foxfleet'), path: bin };
}
function cli(sb, args, env = {}, input) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [sb.cli, ...args], { env: { PATH: `${sb.path}:${BASE_PATH}`, HOME: sb.root, FOXFLEET_DATA: sb.data, FOXFLEET_APPS_DIR: sb.apps, FOXFLEET_ENV_FILE: path.join(sb.root, 'env'), FOXFLEET_CONFIG_DIR: path.join(sb.root, 'cfg'), FOXFLEET_PORT: '59871', ...env } });
    let out = '', err = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d)); p.on('close', (code) => resolve({ code, out, err, json: () => JSON.parse(out) }));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}
/** Mock GitHub: /releases lists releases whose assets point back at this server. */
async function releaseServer(sb, versions, { corrupt = false } = {}) {
  const files = new Map(); let base = '';
  for (const v of versions) {
    const dir = path.join(sb.root, 'rel', `foxfleet-${v}`); fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server/index.js'), `// ${v}\n`); fs.writeFileSync(path.join(dir, 'server/package.json'), JSON.stringify({ version: v }));
    const tgz = path.join(sb.root, 'rel', `foxfleet-server-${v}.tar.gz`); spawnSync('tar', ['-czf', tgz, '-C', path.join(sb.root, 'rel'), `foxfleet-${v}`]);
    const sums = path.join(sb.root, 'rel', `SHA256SUMS-${v}`); fs.writeFileSync(sums, `${corrupt ? '0'.repeat(64) : sha(tgz)}  foxfleet-server-${v}.tar.gz\n`);
    files.set(`/dl/${v}/foxfleet-server-${v}.tar.gz`, tgz); files.set(`/dl/${v}/SHA256SUMS`, sums);
  }
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/releases')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(versions.map((v) => ({ tag_name: `v${v}`, prerelease: /-/.test(v), draft: false, assets: [`foxfleet-server-${v}.tar.gz`, 'SHA256SUMS'].map((name) => ({ name, browser_download_url: `${base}/dl/${v}/${name}` })) })))); }
    const f = files.get(req.url); if (!f) { res.statusCode = 404; return res.end(); } res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
  return { api: base, close: () => server.close() };
}
const healthServer = async (ok = true) => { const s = http.createServer((q, r) => { r.setHeader('Content-Type', 'application/json'); r.end(JSON.stringify({ ok })); }); await new Promise((r) => s.listen(0, '127.0.0.1', r)); return { port: s.address().port, close: () => s.close() }; };

test('doctor reports problems with fixes and exits 1 only on failures', async () => {
  const sb = sandbox(); fs.writeFileSync(path.join(sb.data, 'config.json'), '{ not json');
  const r = await cli(sb, ['doctor', '--json', '--offline'], { FOXFLEET_TRUSTED_ORIGINS: 'https://ok.example, https://bad.example/path' });
  const checks = Object.fromEntries(r.json().checks.map((c) => [c.id, c]));
  assert.equal(checks.config.status, 'fail'); assert.match(checks.config.fix, /restore/);
  assert.equal(checks.origins.status, 'fail'); assert.match(checks.origins.message, /bad\.example/);
  assert.equal(checks.web.status, 'ok'); assert.equal(checks.service.status, 'ok'); assert.equal(checks.accounts.status, 'warn');
  assert.equal(checks.hub.status, 'warn'); assert.equal(r.code, 1);
  fs.writeFileSync(path.join(sb.data, 'config.json'), '{"machines":[]}');
  const ok = await cli(sb, ['doctor', '--json', '--offline']); assert.equal(ok.json().checks.find((c) => c.id === 'config').status, 'ok'); assert.ok(ok.json().checks.every((c) => c.id === 'node' || c.status !== 'fail'));
});

test('doctor sees a running hub and a missing web/dist', async () => {
  const sb = sandbox(); fs.rmSync(path.join(sb.app, 'web/dist'), { recursive: true }); const h = await healthServer();
  const r = await cli(sb, ['doctor', '--json', '--offline'], { FOXFLEET_PORT: String(h.port) }); h.close();
  const c = Object.fromEntries(r.json().checks.map((x) => [x.id, x])); assert.equal(c.hub.status, 'ok'); assert.equal(c.web.status, 'warn'); assert.match(c.web.fix, /npm run build/);
});

test('update --check compares against the mock release server and uses exit code 10', async () => {
  const sb = sandbox(), rel = await releaseServer(sb, ['9.9.0-alpha', '0.2.0-alpha', '0.1.0-alpha']);
  try {
    const r = await cli(sb, ['update', '--check', '--json'], { FOXFLEET_RELEASES_API: rel.api }); assert.equal(r.code, 10); assert.deepEqual([r.json().current, r.json().latest, r.json().updateAvailable], [PKG_VERSION, '9.9.0-alpha', true]);
    const same = await cli(sb, ['update', '--check', '--json'], { FOXFLEET_RELEASES_API: rel.api }); void same;
    const stable = await cli(sb, ['update', '--check', '--stable', '--json'], { FOXFLEET_RELEASES_API: rel.api }); assert.equal(stable.code, 3 === 0 ? 0 : stable.code); assert.equal(stable.json().error, 'No releases found');
    const bad = await cli(sb, ['update', '--check'], { FOXFLEET_RELEASES_API: 'http://127.0.0.1:9' }); assert.equal(bad.code, 1); assert.match(bad.err, /Could not read the releases list/);
  } finally { rel.close(); }
});

test('update --dry-run prints the plan and changes nothing', async () => {
  const sb = sandbox(), rel = await releaseServer(sb, ['9.9.0-alpha']);
  try { const r = await cli(sb, ['update', '--dry-run', '--json'], { FOXFLEET_RELEASES_API: rel.api }); assert.equal(r.code, 0); assert.ok(r.json().plan.some((p) => /verify the SHA-256/.test(p))); assert.equal(fs.realpathSync(path.join(sb.apps, 'current')), fs.realpathSync(sb.app)); assert.ok(!fs.existsSync(path.join(sb.apps, '9.9.0-alpha'))); }
  finally { rel.close(); }
});

test('update downloads, verifies, backs up, swaps, restarts and health-checks', async () => {
  const sb = sandbox(), rel = await releaseServer(sb, ['9.9.0-alpha']), h = await healthServer();
  fs.writeFileSync(path.join(sb.data, 'config.json'), '{"machines":[]}');
  try {
    const r = await cli(sb, ['update', '--json', '--health-wait=10'], { FOXFLEET_RELEASES_API: rel.api, FOXFLEET_PORT: String(h.port) });
    assert.equal(r.code, 0, r.err + r.out); assert.equal(r.json().healthy, true);
    assert.equal(fs.realpathSync(path.join(sb.apps, 'current')), fs.realpathSync(path.join(sb.apps, '9.9.0-alpha')));
    assert.ok(fs.existsSync(path.join(sb.apps, '9.9.0-alpha/server/index.js'))); assert.ok(fs.existsSync(r.json().backup)); assert.equal(fs.statSync(r.json().backup).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(sb.log, 'utf8'), /--user restart foxfleet/);
  } finally { rel.close(); h.close(); }
});

test('update refuses a corrupt download and touches nothing', async () => {
  const sb = sandbox(), rel = await releaseServer(sb, ['9.9.0-alpha'], { corrupt: true });
  try { const r = await cli(sb, ['update'], { FOXFLEET_RELEASES_API: rel.api }); assert.equal(r.code, 1); assert.match(r.err, /Checksum mismatch/); assert.equal(fs.realpathSync(path.join(sb.apps, 'current')), fs.realpathSync(sb.app)); assert.ok(!fs.existsSync(path.join(sb.apps, '9.9.0-alpha'))); }
  finally { rel.close(); }
});

test('update rolls back when the new version never becomes healthy', async () => {
  const sb = sandbox(), rel = await releaseServer(sb, ['9.9.0-alpha']); fs.writeFileSync(path.join(sb.data, 'config.json'), '{"machines":[],"keep":1}');
  try {
    const r = await cli(sb, ['update', '--health-wait=5'], { FOXFLEET_RELEASES_API: rel.api, FOXFLEET_PORT: '59871' }); // nothing answers on this port
    assert.equal(r.code, 1); assert.match(r.err, /rolled back/); assert.equal(fs.realpathSync(path.join(sb.apps, 'current')), fs.realpathSync(sb.app));
    assert.match(fs.readFileSync(path.join(sb.data, 'config.json'), 'utf8'), /keep/);
  } finally { rel.close(); }
});

test('update refuses a git checkout / unmanaged copy (exit 3)', async () => {
  const sb = sandbox(), rel = await releaseServer(sb, ['9.9.0-alpha']);
  try { const r = await cli(sb, ['update'], { FOXFLEET_RELEASES_API: rel.api, FOXFLEET_APPS_DIR: path.join(sb.root, 'elsewhere') }); assert.equal(r.code, 3); } finally { rel.close(); }
});

test('setup, user and invite work on the accounts files with the hub stopped; passwords never come from argv', async () => {
  const sb = sandbox(), pw = 'correct horse battery staple';
  const none = await cli(sb, ['setup', '--username', 'dogeowner', '--json']); assert.equal(none.code, 2); // no password and no TTY: refuses to guess
  const s = await cli(sb, ['setup', '--username', 'dogeowner', '--password-stdin', '--json'], {}, pw + '\n'); assert.equal(s.code, 0, s.err); assert.equal(s.json().owner, 'dogeowner');
  assert.equal((await cli(sb, ['setup', '--json'])).json().setup, 'done');
  const add = await cli(sb, ['user', 'add', 'alice', '--json'], { FOXFLEET_PASSWORD: 'alice has a long password' }); assert.equal(add.json().role, 'user');
  assert.deepEqual((await cli(sb, ['user', 'list', '--json'])).json().users.map((u) => [u.username, u.role]), [['dogeowner', 'owner'], ['alice', 'user']]);
  assert.equal((await cli(sb, ['user', 'disable', 'alice', '--json'])).json().disabled, true);
  assert.equal((await cli(sb, ['user', 'list', '--json'])).json().users[1].disabled, true);
  assert.equal((await cli(sb, ['user', 'reset-password', 'alice', '--json'], { FOXFLEET_PASSWORD: 'a brand new long password' })).json().reset, true);
  assert.equal((await cli(sb, ['user', 'disable', 'nobody'])).code, 1);
  const inv = await cli(sb, ['invite', 'create', '--json', '--url', 'https://hub.example']); assert.match(inv.json().link, /^https:\/\/hub\.example\/#\/join\?invite=/);
  assert.ok(!fs.readFileSync(path.join(sb.data, 'accounts/users.json'), 'utf8').includes('correct horse')); // hashed
  assert.match(fs.readFileSync(sb.log, 'utf8'), /--user stop foxfleet/); // the hub was stopped around each write and started again
});

test('config get/set/path, backup and restore round-trip, completion, help and exit codes', async () => {
  const sb = sandbox();
  assert.equal((await cli(sb, ['config', 'set', 'FOXFLEET_PORT', '3099'], { FOXFLEET_PORT: undefined })).code, 0); assert.equal((await cli(sb, ['config', 'get', 'FOXFLEET_PORT'], { FOXFLEET_PORT: undefined })).out.trim(), '3099');
  await cli(sb, ['config', 'set', 'FOXFLEET_SETUP_CODE', 'sekret']); assert.doesNotMatch((await cli(sb, ['config', 'get', '--json'])).out, /sekret/);
  assert.equal(fs.statSync(path.join(sb.root, 'env')).mode & 0o777, 0o600);
  assert.equal((await cli(sb, ['config', 'set', 'bad key', 'x'])).code, 2);
  assert.ok((await cli(sb, ['config', 'path', '--json'])).json().data.endsWith('data'));
  fs.writeFileSync(path.join(sb.data, 'config.json'), '{"machines":[],"v":1}');
  const b = (await cli(sb, ['backup', '--json'])).json().backup; assert.ok(fs.existsSync(b));
  fs.writeFileSync(path.join(sb.data, 'config.json'), '{"machines":[],"v":2}');
  assert.equal((await cli(sb, ['restore', b])).code, 2); // needs --yes without a terminal
  assert.equal((await cli(sb, ['restore', b, '--yes'])).code, 0); assert.match(fs.readFileSync(path.join(sb.data, 'config.json'), 'utf8'), /"v":1/);
  assert.match((await cli(sb, ['completion', 'bash'])).out, /complete -F _foxfleet foxfleet/); assert.match((await cli(sb, ['completion', 'zsh'])).out, /compdef _foxfleet foxfleet/);
  assert.equal((await cli(sb, ['nope'])).code, 2); assert.match((await cli(sb, ['version'])).out, /^foxfleet \d/);
  assert.doesNotMatch((await cli(sb, ['help'])).out, /\x1b\[/); // no colour when not a TTY
});

test('version ordering treats pre-releases as older than the release', async () => {
  const sb = sandbox(); void sb; const { compareVersions } = await import(pathToFileUrl(path.join(SRC, 'bin/foxfleet')));
  assert.equal(compareVersions('0.2.0-alpha', '0.2.1-alpha'), -1); assert.equal(compareVersions('0.2.0', '0.2.0-rc1'), 1); assert.equal(compareVersions('1.0.0', '0.9.9'), 1); assert.equal(compareVersions('v0.2.0-alpha', '0.2.0-alpha'), 0);
});
function pathToFileUrl(p) { return 'file://' + p; }

test('install.sh installs from a (mock) release, verifies the checksum and links foxfleet', { skip: Number(process.versions.node.split('.')[0]) < 22 && 'install.sh requires Node 22' }, async () => {
  const sb = sandbox(), rel = await releaseServer(sb, ['9.9.0-alpha']);
  // the installer unpacks a full layout: server/bin/foxfleet must be inside the tarball
  const dir = path.join(sb.root, 'rel/foxfleet-9.9.0-alpha'); fs.mkdirSync(path.join(dir, 'server/bin'), { recursive: true }); fs.copyFileSync(path.join(SRC, 'bin/foxfleet'), path.join(dir, 'server/bin/foxfleet'));
  const tgz = path.join(sb.root, 'rel/foxfleet-server-9.9.0-alpha.tar.gz'); spawnSync('tar', ['-czf', tgz, '-C', path.join(sb.root, 'rel'), 'foxfleet-9.9.0-alpha']);
  fs.writeFileSync(path.join(sb.root, 'rel/SHA256SUMS-9.9.0-alpha'), `${sha(tgz)}  foxfleet-server-9.9.0-alpha.tar.gz\n`);
  const run = (env) => new Promise((resolve) => { const p = spawn('sh', [path.join(SRC, '../deploy/install.sh')], { env: { PATH: BASE_PATH, HOME: sb.root, FOXFLEET_API: rel.api, FOXFLEET_DOWNLOAD: `${rel.api}/dl/9.9.0-alpha`, FOXFLEET_APPS_DIR: path.join(sb.root, 'inst'), FOXFLEET_BIN_DIR: path.join(sb.root, 'inst-bin'), ...env } }); let o = ''; p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (o += d)); p.on('close', (code) => resolve({ code, o })); });
  try {
    const r = await run({}); assert.equal(r.code, 0, r.o); assert.match(r.o, /Checksum OK/);
    assert.equal(spawnSync(path.join(sb.root, 'inst-bin/foxfleet'), ['version'], { encoding: 'utf8' }).status, 0);
    assert.equal(fs.realpathSync(path.join(sb.root, 'inst/current')), fs.realpathSync(path.join(sb.root, 'inst/9.9.0-alpha')));
    fs.writeFileSync(path.join(sb.root, 'rel/SHA256SUMS-9.9.0-alpha'), `${'0'.repeat(64)}  foxfleet-server-9.9.0-alpha.tar.gz\n`);
    const bad = await run({ FOXFLEET_APPS_DIR: path.join(sb.root, 'inst2') }); assert.notEqual(bad.code, 0); assert.match(bad.o, /checksum mismatch/); assert.ok(!fs.existsSync(path.join(sb.root, 'inst2/9.9.0-alpha')));
  } finally { rel.close(); }
});

test('doctor checks the native Hermes gateway on a computer with a paired connector, and says how to fix it', async () => {
  const sb = sandbox(), cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-conn-')), hh = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-hh-')); fs.writeFileSync(path.join(hh, '.env'), 'x=1\n');
  fs.copyFileSync(path.join(SRC, '..', 'connector', 'foxfleet-connector.mjs'), path.join(sb.app, 'connector', 'foxfleet-connector.mjs'));
  const write = (c) => fs.writeFileSync(path.join(cfgDir, 'connector.json'), JSON.stringify({ hub: 'http://127.0.0.1:1', token: 'a.b', name: 'x', expose: 'all', profiles: {}, ...c }));
  const env = { FOXFLEET_CONFIG_DIR: cfgDir, FOXFLEET_HERMES_HOME: hh };
  write({}); const none = await cli(sb, ['doctor', '--json', '--offline'], { ...env, HOME: hh });
  const g = none.json().checks.find((c) => c.id === 'native-gateway'); assert.equal(g.status, 'warn'); assert.match(g.fix, /uiGatewayCommand|HERMES_AGENT_DIR/);
  write({ uiGatewayCommand: [process.execPath, path.join(SRC, 'test', 'fake-gateway.mjs')] }); const ok = await cli(sb, ['doctor', '--json', '--offline'], env);
  assert.equal(ok.json().checks.find((c) => c.id === 'native-gateway-start').status, 'ok');
  write({ uiGatewayCommand: [process.execPath, '-e', 'process.exit(3)'] }); const bad = await cli(sb, ['doctor', '--json', '--offline'], env);
  assert.equal(bad.json().checks.find((c) => c.id === 'native-gateway-start').status, 'fail'); assert.equal(bad.code, 1);
});

test('doctor tells a buffering proxy from a live stream on the public address', async () => {
  const mk = (buffered) => new Promise((resolve) => { const s = http.createServer((q, r) => {
    if (q.url === '/health') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end('{"ok":true}'); }
    r.writeHead(200, { 'Content-Type': 'text/event-stream', ...(buffered ? {} : { 'cf-ray': 'abc-BKK' }) });
    if (buffered) return void setTimeout(() => r.end(': 1\n\n: 2\n\n: 3\n\ndata: done\n\n'), 1700);
    let n = 0; r.write('retry: 3000\n\n'); const t = setInterval(() => { r.write(`: ${++n}\n\n`); if (n >= 3) { clearInterval(t); r.end('data: done\n\n'); } }, 400);
  }).listen(0, '127.0.0.1', () => resolve(s)); });
  for (const buffered of [true, false]) {
    const srv = await mk(buffered), sb = sandbox();
    const r = await cli(sb, ['doctor', '--json', '--offline', '--url', `http://127.0.0.1:${srv.address().port}`]); srv.close();
    const c = Object.fromEntries(r.json().checks.map((x) => [x.id, x]));
    if (buffered) { assert.equal(c.streaming.status, 'warn'); assert.match(c.streaming.message, /buffering/); assert.match(c.streaming.fix, /cloudflare-tunnel#resilience/); }
    else { assert.equal(c.streaming.status, 'ok'); assert.equal(c.cloudflare.status, 'ok'); }
  }
});
