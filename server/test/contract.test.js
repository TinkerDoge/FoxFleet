// Runs the shared contract scenario (contract/run.mjs) against the real hub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../index.js';
import { runContract, spec } from '../../contract/run.mjs';
import { validate, operations } from '../../contract/validate.mjs';

test('contract: the real hub honours contract/openapi.json', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-contract-'));
  const server = await createHub({ configPath: path.join(dir, 'config.json') }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await new Promise((r) => setTimeout(r, 20)); await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  const covered = await runContract(`http://127.0.0.1:${server.address().port}`);
  assert.ok(covered.length >= 22, `only ${covered.length} operations covered`);
});
test('contract: every operation has an id and declared responses; validator catches violations', () => {
  const ops = operations(spec), ids = ops.map((o) => o.operationId);
  assert.equal(new Set(ids).size, ids.length); assert.ok(ops.length >= 38);
  for (const o of ops) assert.ok(Object.keys(o.responses).length > 0, o.operationId);
  assert.equal(spec.openapi, '3.1.0');
  const schema = { $ref: '#/components/schemas/AuthInfo' };
  assert.deepEqual(validate(schema, { required: true, authenticated: false }, spec), []);
  assert.match(validate(schema, { required: 'yes' }, spec).join(), /expected boolean/);
  assert.match(validate(schema, { required: true, authenticated: false, registration: 'weird' }, spec).join(), /not in/);
  assert.match(validate(schema, { required: true }, spec).join(), /missing required "authenticated"/);
});
