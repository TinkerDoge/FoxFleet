import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLive, readLiveCatalog } from '../commands.js';

test('readLiveCatalog keeps Hermes fields and drops anything that is not plain catalog data', () => {
  const live = readLiveCatalog({
    pairs: [['/ship', 'Ship it'], ['nope', 'ignored'], ['/ok', 12]],
    sub: { ship: ['now', 1], __proto__: ['x'] },
    canon: { '/ship': '/ship', 'alias': '/ship' },
    commands: { '/ship': { argument_mode: 'text', desktop: null, nested: { a: 1 } } },
    categories: [{ name: 'Plugins', pairs: [['/ship', 'Ship it']] }],
    skills: { '/deploy-notes': { usage: 'notes', origin: 'project' }, 'Bad Name': { usage: 'no' } },
    warning: 'skill discovery unavailable: boom',
  });
  assert.deepEqual(live.pairs, [['/ship', 'Ship it'], ['/ok', '12']]);
  assert.deepEqual(live.sub.ship, ['now']);
  assert.equal(live.canon['/ship'], '/ship');
  assert.equal(live.commands['/ship'].argument_mode, 'text');
  assert.equal(live.commands['/ship'].nested, undefined);
  assert.deepEqual(live.skillNames, ['deploy-notes']);
  assert.equal(live.skills['/deploy-notes'].origin, 'project');
  assert.equal(live.skillCount, 1);
  assert.match(live.warning, /skill discovery/);
});

test('applyLive adds discovered names without making them executable, and keeps bundled commands', () => {
  const base = [{ name: 'new', aliases: ['reset'], description: 'New', category: 'Session', availability: 'app' }];
  const live = readLiveCatalog({
    pairs: [['/new', 'New'], ['/ship', 'Ship it'], ['/deploy-notes', 'Notes']],
    sub: { ship: ['now'] },
    categories: [{ name: 'Plugins', pairs: [['/ship', 'Ship it']] }],
    skills: { '/deploy-notes': { origin: 'project' } },
    warning: 'session catalog',
  });
  const out = applyLive(base, live);
  assert.equal(out.commands[0].name, 'new');
  const ship = out.commands.find((c) => c.name === 'ship');
  assert.equal(ship.executable, false);
  assert.equal(ship.availability, 'unavailable');
  assert.equal(ship.category, 'Plugins');
  assert.deepEqual(ship.subcommands, ['now']);
  assert.equal(out.commands.some((c) => c.name === 'deploy-notes'), false);
  assert.deepEqual(out.skills, ['deploy-notes']);
  assert.equal(out.warning, 'session catalog');
});
