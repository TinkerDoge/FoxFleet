// Release gate (run by release.yml on a tag push): the tag, package.json, CHANGELOG and the roadmap must all agree before anything is published.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readRoadmap, latestReleased } from './roadmap.mjs';
const root = resolve(import.meta.dirname, '../..'), tag = process.argv[2] ?? '';
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const fail = (m) => { console.error('release check: ' + m); process.exit(1); };
if (tag !== `v${version}`) fail(`tag ${tag} does not match package.json version ${version}.`);
if (latestReleased(readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8')) !== version) fail(`CHANGELOG.md has no released entry for ${version} (remove "(unreleased)" from its heading).`);
try { if (readRoadmap(root).releasedVersion !== version) fail(`docs/roadmap.html releasedVersion must be ${version}.`); } catch (e) { fail(e.message); }
console.log(`release check: ${tag} is consistent`);
