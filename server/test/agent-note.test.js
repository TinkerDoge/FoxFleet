// Agent awareness: the note text (golden), the config.yaml edit (round trip through a real YAML parser), consent, the fallback, and the real gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { agentNote, editConfigYaml, readNote, noteStatus, applyNote, wrapNote, UI_OPS, SESSION_SOURCE, HermesGateway, installNotes, removeNotes, noteDoctor, fallbackNote, hermesNoteSupport, profileNote } from '../../connector/foxfleet-connector.mjs';
import { parseMedia } from '../media-tags.js';
import { setup, REAL } from './ui-helpers.js';
import { fakeLlm } from './fake-llm.js';
import { waitFor, runConnector } from './machine-helpers.js';
import { fileURLToPath } from 'node:url';

const GOLDEN = fileURLToPath(new URL('../../contract/agent-note.golden.txt', import.meta.url));
const FIXED = { cfg: { mediaMaxBytes: 25 * 1048576 }, roots: ['/home/u/.hermes/cache', '/home/u/work', '/tmp'], home: '/home/u' };
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ff-note-'));
const PY = process.env.NOTE_PYTHON || '/tmp/hv/bin/python';
const yamlLoad = (text) => { const r = spawnSync(PY, ['-c', 'import sys,yaml,json;print(json.dumps(yaml.safe_load(sys.stdin.read())))'], { input: text, encoding: 'utf8' }); if (r.status !== 0) throw new Error('yaml: ' + r.stderr); return JSON.parse(r.stdout); };
const HAVE_YAML = spawnSync(PY, ['-c', 'import yaml']).status === 0;

test('the note: golden text, small, deterministic, hash follows the words', () => {
  const n = agentNote(FIXED);
  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, n.text + '\n');
  assert.equal(n.text + '\n', fs.readFileSync(GOLDEN, 'utf8'), 'contract/agent-note.golden.txt (regenerate with UPDATE_GOLDEN=1 when the wording changes on purpose)');
  assert.ok(n.text.length < 1800, `short enough for a cached prompt prefix: ${n.text.length}`);
  assert.deepEqual(agentNote(FIXED), n); assert.match(n.text, /\(foxfleet-note v[0-9a-f]{8}\)/);
  for (const must of ['FoxFleet', 'not a terminal', 'MEDIA:/absolute/path', '/tmp, ~/.hermes/cache, ~/work', 'tap-to-answer cards', '/compress', 'phone', 'ANSI']) assert.ok(n.text.includes(must), must);
  assert.notEqual(agentNote({ ...FIXED, cfg: { mediaMaxBytes: 5 * 1048576 } }).hash, n.hash);
  assert.ok(agentNote({ ...FIXED, features: [] }).text.includes('no attachment channel'));
});

test('connector params: create and resume carry source=foxfleet; an old Hermes that rejects it is retried once without', async () => {
  assert.equal(SESSION_SOURCE, 'foxfleet'); assert.equal(UI_OPS.create({})[1].source, 'foxfleet');
  const sent = [];
  const gw = new HermesGateway({ profile: 'p', home: '/x', launch: () => null, emit() {} });
  gw.ensure = async () => {}; gw.rpc = async (m, p) => { sent.push([m, { ...p }]); if (p.source && gw.reject) throw Object.assign(new Error('Extra inputs are not permitted: source'), { rpc: -32602 }); return { session_id: 'rt1', stored_session_id: 's1', message_count: 0 }; };
  await gw.call('create', {}); await gw.call('attach', { stored_session_id: 's2' });
  assert.deepEqual(sent.map(([m, p]) => [m, p.source]), [['session.create', 'foxfleet'], ['session.resume', 'foxfleet']]);
  sent.length = 0; gw.reject = true; gw.runtime.clear(); await gw.call('attach', { stored_session_id: 's3' });
  assert.deepEqual(sent.map(([m, p]) => [m, p.source]), [['session.resume', 'foxfleet'], ['session.resume', undefined]]); assert.equal(gw.noSource, true);
  sent.length = 0; await gw.call('create', {}); assert.deepEqual(sent.map(([, p]) => p.source), [undefined], 'remembered');
});

test('fallback: a new chat carries the wrapped note once, on its first message only', async () => {
  const sent = []; const note = agentNote(FIXED);
  const gw = new HermesGateway({ profile: 'p', home: '/x', launch: () => null, emit() {}, note: () => note });
  gw.ensure = async () => {}; gw.rpc = async (m, p) => { sent.push([m, { ...p }]); return { session_id: 'rt1', stored_session_id: 's1' }; };
  await gw.call('create', {}); await gw.call('submit', { session_id: 'rt1', text: 'hello' }); await gw.call('submit', { session_id: 'rt1', text: 'again' });
  const prompts = sent.filter(([m]) => m === 'prompt.submit').map(([, p]) => p.text);
  assert.equal(prompts[0], wrapNote(note, 'hello')); assert.equal(prompts[1], 'again');
  const none = new HermesGateway({ profile: 'p', home: '/x', launch: () => null, emit() {}, note: () => null }); none.ensure = async () => {}; none.rpc = async () => ({ session_id: 'r', stored_session_id: 's' });
  await none.call('create', {}); assert.equal(none.fresh.size, 0);
});

test('hub transcript hides the fallback note from the user message', async () => {
  const { normalizeTranscript } = await import('../transcript.js');
  const rows = [{ role: 'user', content: wrapNote(agentNote(FIXED), 'hello there') }, { role: 'assistant', content: 'hi' }];
  const msgs = normalizeTranscript(rows); assert.equal(msgs[0].content, 'hello there');
});

test('config.yaml edit: round trip through a real YAML parser, idempotent, other keys untouched, removable', { skip: !HAVE_YAML && 'needs python with PyYAML (NOTE_PYTHON)' }, () => {
  const note = agentNote(FIXED);
  const cases = {
    absent: 'model:\n  default: x\n# my comment\nagent:\n  system_prompt: hi\n',
    empty: 'model: x\nplatform_hints: {}\nother: 1\n',
    bare: 'platform_hints:\nother: 1\n',
    others: 'platform_hints:\n    slack:\n        append: be brief\nz: 2\n',
    none: '',
    crlf: 'a: 1\r\nb: 2\r\n',
    noEol: 'a: 1',
  };
  for (const [name, src] of Object.entries(cases)) {
    const r = editConfigYaml(src, note.text); assert.equal(r.changed, true, name);
    const doc = yamlLoad(r.text); assert.equal(doc.platform_hints.foxfleet.replace, note.text, name);
    const before = yamlLoad(src || '{}') ?? {}; for (const [k, v] of Object.entries(before)) if (k !== 'platform_hints') assert.deepEqual(doc[k], v, name + ':' + k);
    if (name === 'others') assert.equal(doc.platform_hints.slack.append, 'be brief');
    assert.equal(readNote(r.text), note.text, name);
    const again = editConfigYaml(r.text, note.text); assert.equal(again.changed, false, name + ' idempotent'); assert.equal(again.text, r.text);
    const upd = editConfigYaml(r.text, note.text + '\nextra'); assert.equal(yamlLoad(upd.text).platform_hints.foxfleet.replace, note.text + '\nextra', name + ' update');
    const rm = editConfigYaml(r.text, '', 'remove'); assert.equal(rm.changed, true); assert.ok(!rm.text.includes('foxfleet'), name + ' removed');
    const back = yamlLoad(rm.text) ?? {}; for (const [k, v] of Object.entries(before)) if (k !== 'platform_hints') assert.deepEqual(back[k], v, name + ' after remove');
    if (name === 'absent' || name === 'none' || name === 'noEol') assert.equal(rm.text.trimEnd(), src.trimEnd(), name + ' removal restores the file');
  }
  assert.throws(() => editConfigYaml('platform_hints:\n  foxfleet:\n    append: mine\n', note.text), (e) => e.code === 'user-owned');
  assert.throws(() => editConfigYaml('platform_hints: {a: {append: x}}\n', note.text), (e) => e.code === 'unsupported-yaml');
  assert.throws(() => editConfigYaml('x: 1\n# foxfleet-agent-note:begin\n', note.text), (e) => e.code === 'damaged');
  assert.equal(editConfigYaml('x: 1\n', '', 'remove').changed, false);
});

test('apply/status/consent: backup once, atomic, per-profile status, opt-out, decline falls back', async () => {
  const root = tmp(), home = path.join(root, 'profiles', 'a'); fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'config.yaml'), 'model: x\n'); fs.writeFileSync(path.join(root, 'config.yaml'), 'model: y\n');
  const cfg = { expose: 'all' }, note = agentNote({ cfg, roots: [] });
  assert.equal(noteStatus(home, note, cfg).status, 'missing');
  const rows = noteDoctor(cfg, { root }); assert.deepEqual(rows.map((r) => [r.id, r.status]), [['agent-note:default', 'warn'], ['agent-note:a', 'warn']]);
  // declined: nothing written, fallback stays on
  let saved = null; const out1 = await installNotes(cfg, { root, yes: false, ask: async () => false, support: null, save: (c) => { saved = c; } });
  assert.match(out1[0], /Not written/); assert.equal(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'), 'model: x\n'); assert.equal(saved.agentNote, 'message');
  assert.ok(fallbackNote(saved, root, home), 'declined users still get the first-message note');
  // consent
  const out2 = await installNotes(cfg, { root, yes: true, support: null, save: (c) => { saved = c; } });
  assert.ok(out2.some((l) => /profile a: note written \(backup/.test(l))); assert.equal(saved.agentNote, true);
  assert.equal(fs.readFileSync(path.join(home, 'config.yaml.foxfleet.bak'), 'utf8'), 'model: x\n');
  assert.equal(noteStatus(home, profileNoteFor(root, home, saved), saved).status, 'installed'); assert.equal(fallbackNote(saved, root, home), null, 'installed: no fallback');
  assert.match((await installNotes(saved, { root, yes: true, support: null, save() {} })).join(), /already up to date/);
  assert.equal(fs.readFileSync(path.join(home, 'config.yaml.foxfleet.bak'), 'utf8'), 'model: x\n', 'the backup is the original, kept once');
  // opt out + remove
  const gone = removeNotes(saved, { root, save: (c) => { saved = c; } }); assert.ok(gone.some((l) => /note removed/.test(l))); assert.equal(saved.agentNote, false);
  assert.equal(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'), 'model: x\n'); assert.equal(fallbackNote(saved, root, home), null, 'agentNote:false sends nothing');
  assert.equal(noteStatus(home, note, saved).status, 'disabled');
  assert.match((await installNotes(saved, { root, yes: true, support: null, explicit: false, save() {} }))[0], /is off/, 'doctor --fix respects the opt-out');
  // Hermes without platform_hints
  assert.match((await installNotes({ expose: 'all' }, { root, yes: true, support: { hints: false }, save() {} }))[0], /no platform_hints/);
  assert.equal(noteStatus(home, note, {}, { hints: false }).status, 'unsupported');
  assert.equal(hermesNoteSupport({ cmd: '/bin/node', args: [] }), null);
});
const profileNoteFor = (root, home, cfg) => profileNote(cfg, root, home);

test('real gateway: the model receives the FoxFleet note (and not the TUI text), byte-stable across turns and after resume', async (t) => {
  if (!REAL || !process.env.FAKE_LLM_PORT) return t.skip('set HERMES_REAL_GATEWAY_TEST and FAKE_LLM_PORT');
  const llm = fakeLlm(); await llm.listen(Number(process.env.FAKE_LLM_PORT)); t.after(() => llm.close());
  const x = await setup(t), { ui, agent } = x;
  const cfg = JSON.parse(fs.readFileSync(path.join(x.cfgDir, 'connector.json'), 'utf8'));
  const inst = runConnector(t, ['agent-note', 'install', '--yes'], { hermes: x.root, configDir: x.cfgDir }); assert.equal(await inst.done, 0, inst.out); assert.match(inst.out, /note written/);
  const note = agentNote({ cfg, roots: [] }); const stored = fs.readFileSync(path.join(x.root, 'config.yaml'), 'utf8'); assert.ok(stored.includes('foxfleet-agent-note:begin'));
  const hash = /foxfleet-note v([0-9a-f]{8})/.exec(stored)[1];
  const reqFor = (text) => llm.log.find((b) => (b.messages ?? []).some((q) => q.role === 'user' && String(typeof q.content === 'string' ? q.content : JSON.stringify(q.content)).includes(text)) && (b.messages ?? []).some((q) => q.role === 'system'));
  const systemOf = (text) => { const m = reqFor(text).messages.find((q) => q.role === 'system'); return typeof m.content === 'string' ? m.content : JSON.stringify(m.content); };
  const turn = async (rt, text) => { const n = x.events.filter((e) => e.type === 'message.complete' && e.session_id === rt).length; await ui.call(agent, 'submit', { session_id: rt, text }); await waitFor(async () => (x.events.filter((e) => e.type === 'message.complete' && e.session_id === rt).length > n ? true : null), { tries: 300, ms: 100 }); };
  const c = await ui.call(agent, 'create', {}); await turn(c.session_id, 'where am I?'); await turn(c.session_id, 'and now?');
  if (process.env.DUMP) fs.writeFileSync('/tmp/llm-log.json', JSON.stringify(llm.log));
  const s0 = systemOf('where am I?'), s1 = systemOf('and now?');
  assert.ok(s0.includes('You are chatting through FoxFleet') && s0.includes('(foxfleet-note v' + hash + ')'), 'note present');
  assert.ok(!/terminal UI \(TUI\)/.test(s0) && !/You are in a plain terminal/.test(s0), 'the TUI hint is gone');
  assert.ok(!reqFor('where am I?').messages.some((q) => q.role === 'user' && String(q.content).includes('foxfleet-note')), 'installed note is not repeated in the user message');
  assert.equal(s1, s0, 'system prompt is byte-stable across turns');
  const rows = await ui.call(agent, 'sessions', {}); assert.ok(JSON.stringify(rows).includes('foxfleet'), 'the session is stored with source foxfleet');
  const again = await ui.call(agent, 'attach', { stored_session_id: c.stored_session_id }); await turn(again.session_id, 'third');
  assert.equal(systemOf('third'), s0, 'a resumed chat keeps the same note bytes');
  // fallback: remove the block (opt-out of the config write) and a NEW chat gets the note on its first message
  fs.writeFileSync(path.join(x.root, 'config.yaml'), fs.readFileSync(path.join(x.root, 'config.yaml'), 'utf8').replace(/# foxfleet-agent-note:begin[\s\S]*# foxfleet-agent-note:end\n?/, '').replace(/platform_hints:\s*\n/, ''));
  const c2 = await ui.call(agent, 'create', {}); await turn(c2.session_id, 'hello?');
  const first = reqFor('hello?').messages.filter((q) => q.role === 'user')[0].content; assert.ok(String(first).includes('<foxfleet-note>') && String(first).includes('hello?'), 'fallback note rides on the first message');
});
