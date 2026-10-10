// Where Hermes writes its pictures must be shared by default, one command shares more, and a refusal says why (code "outside" + the one-tap fix).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mediaRoots, allowMediaRoot, mediaDoctor, checkMedia, FEATURES, VERSION } from '../../connector/foxfleet-connector.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ff-roots-'));

test('default roots cover Hermes caches in the root and in every profile home, and HERMES_MEDIA_ALLOW_DIRS', (t) => {
  const root = tmp(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = ['cache/images', 'image_cache', 'profiles/work/cache/images', 'profiles/work/cache/videos', 'profiles/other/cache/generated'], extra = tmp(); t.after(() => fs.rmSync(extra, { recursive: true, force: true }));
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  const roots = mediaRoots({ root, home: path.join(root, 'profiles/work'), cfg: {}, env: { HERMES_MEDIA_ALLOW_DIRS: extra }, tmp: path.join(root, 'nope') });
  for (const want of ['cache', 'image_cache', 'profiles/work/cache', 'profiles/other/cache']) assert.ok(roots.some((r) => r === fs.realpathSync(path.join(root, want))), want);
  assert.ok(roots.includes(fs.realpathSync(extra)));
  // a picture a profile saved under its own cache is deliverable, from either the root or that profile
  const png = path.join(root, 'profiles/other/cache/generated/fox.png'); fs.writeFileSync(png, PNG);
  assert.equal(checkMedia(png, roots).ok, true);
});

test('a file outside every root is refused with code "outside", and allow-media shares its folder', (t) => {
  const root = tmp(), work = tmp(); t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); });
  const png = path.join(work, 'chart.png'); fs.writeFileSync(png, PNG);
  const roots = mediaRoots({ root, cfg: {}, env: {}, tmp: path.join(root, 'nope') });
  const bad = checkMedia(png, roots); assert.equal(bad.ok, false); assert.equal(bad.code, 'outside');
  const cfg = allowMediaRoot({ name: 'm' }, work); assert.deepEqual(cfg.mediaRoots, [fs.realpathSync(work)]);
  assert.equal(checkMedia(png, mediaRoots({ root, cfg, env: {}, tmp: path.join(root, 'nope') })).ok, true);
  assert.deepEqual(allowMediaRoot(cfg, work).mediaRoots, cfg.mediaRoots, 'sharing twice keeps one entry');
});

test('allow-media refuses things that are too broad or secret', (t) => {
  const home = tmp(); t.after(() => fs.rmSync(home, { recursive: true, force: true })); fs.mkdirSync(path.join(home, '.ssh'));
  assert.throws(() => allowMediaRoot({}, 'relative/dir'), /absolute path/);
  assert.throws(() => allowMediaRoot({}, path.join(home, 'missing')), /absolute path/);
  assert.throws(() => allowMediaRoot({}, path.parse(home).root), /Too broad/);
  assert.throws(() => allowMediaRoot({}, os.homedir()), /Too broad/);
  assert.throws(() => allowMediaRoot({}, path.join(home, '.ssh')), /credentials/);
  const f = path.join(home, 'f.txt'); fs.writeFileSync(f, 'x'); assert.throws(() => allowMediaRoot({}, f), /file/);
});

test('doctor reports the shared folders, bad entries, and the missing cache', (t) => {
  const root = tmp(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lines = mediaDoctor({ mediaRoots: ['/nonexistent/place'] }, { root, env: {} });
  assert.match(lines[0].message, /media: \d+ shared folder/); assert.match(lines[0].message, new RegExp(VERSION.replace(/\./g, '\\.')));
  assert.ok(lines.some((l) => l.id === 'media-root' && l.status === 'warn' && /nonexistent/.test(l.message)));
  assert.ok(lines.some((l) => l.id === 'media-cache' && /allow-media/.test(l.fix)));
  fs.mkdirSync(path.join(root, 'cache', 'images'), { recursive: true });
  assert.ok(!mediaDoctor({}, { root, env: {} }).some((l) => l.id === 'media-cache'));
  assert.ok(FEATURES.includes('media'));
});
