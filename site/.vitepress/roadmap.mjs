import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KIND_SPECS } from '../../server/config.js';

const columns = ['Next', 'In progress', 'Later', 'Done'];
const areas = ['Hub', 'Web', 'Android', 'Agents', 'Design', 'Docs', 'Releases'];
const markdown = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/\n/g, ' ');

export function readRoadmap(root) {
  const html = readFileSync(resolve(root, 'docs/roadmap.html'), 'utf8');
  const block = html.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  if (!block) throw new Error('Roadmap: docs/roadmap.html must contain its JSON data block.');
  const data = JSON.parse(block[1]);
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  if (data.version !== version) throw new Error(`Roadmap: version ${data.version} differs from package.json (${version}). Update the roadmap snapshot.`);
  if (data.nextVersion) {
    const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
    const upcoming = changelog.match(/^## Unreleased \(([^)]+)\)/m)?.[1];
    if (data.nextVersion !== upcoming) throw new Error('Roadmap: nextVersion must match the Unreleased version in CHANGELOG.md.');
    if (!data.nextReleaseNote) throw new Error('Roadmap: describe the upcoming source changes in nextReleaseNote.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.updated)) throw new Error('Roadmap: updated must be a YYYY-MM-DD date.');
  const ids = new Set();
  for (const item of data.board) {
    if (!item.id || ids.has(item.id)) throw new Error(`Roadmap: missing or duplicate item id ${item.id}.`);
    ids.add(item.id);
    if (!columns.includes(item.col) || !areas.includes(item.area)) throw new Error(`Roadmap: invalid status or area for ${item.id}.`);
    if (!item.text || !item.detail) throw new Error(`Roadmap: ${item.id} needs a title and a description.`);
    if (item.col !== 'Done' && !item.doneWhen) throw new Error(`Roadmap: ${item.id} needs completion criteria.`);
  }
  const kinds = Object.keys(KIND_SPECS);
  const listed = data.providers.filter((p) => p.kind).map((p) => p.kind);
  if (new Set(listed).size !== listed.length || kinds.some((kind) => !listed.includes(kind)) || listed.some((kind) => !kinds.includes(kind))) {
    throw new Error('Roadmap: provider rows must match KIND_SPECS in server/config.js, including planned kinds.');
  }
  const providers = data.providers.map((provider) => {
    const spec = KIND_SPECS[provider.kind];
    if (!spec) return { ...provider, capabilities: 'Undecided' };
    const status = spec.planned ? 'Planned' : 'Implemented';
    if (provider.status !== status) throw new Error(`Roadmap: ${provider.kind} must be marked ${status}.`);
    return { ...provider, name: spec.label, capabilities: Object.entries(spec.capabilities).filter(([, on]) => on).map(([key]) => key).join(', ') || 'Not implemented' };
  });
  return { ...data, providers, areas: areas.filter((area) => data.board.some((item) => item.area === area)) };
}

export function generateRoadmap(root, out) {
  const data = readRoadmap(root);
  const released = data.releasedVersion ?? data.version;
  out('.vitepress/theme/roadmap.generated.json', JSON.stringify(data, null, 2) + '\n');
  let page = `---
title: Roadmap
description: What Foxfleet ships today, the next alpha validation milestones, and future plans.
outline: [2, 3]
editLink: false
---

<script setup>
import RoadmapOverview from '../.vitepress/theme/components/RoadmapOverview.vue'
import RoadmapBoard from '../.vitepress/theme/components/RoadmapBoard.vue'
import roadmap from '../.vitepress/theme/roadmap.generated.json'
</script>

# Roadmap

One hub for your agents. Here is what is available today and what comes next.

<RoadmapOverview :roadmap="roadmap" />

${data.nextVersion ? `<div class="roadmap-release-note">

::: info Release and source status
The public downloads are still **${released}**. The current source targets **${data.nextVersion}**, which is **unreleased**. ${markdown(data.nextReleaseNote)} See the [changelog](./changelog).
:::

</div>
` : ''}

## Next milestones

<div class="roadmap-milestones">
`;
  for (const milestone of data.milestones) {
    page += `\n<div class="roadmap-milestone">\n\n<span class="roadmap-eyebrow">${markdown(milestone.label)}</span>\n\n### ${markdown(milestone.title)}\n\n${markdown(milestone.detail)}\n\n**Complete when:** ${markdown(milestone.doneWhen)}\n\n</div>\n`;
  }
  page += `\n</div>\n\nFuture work is ordered by priority, with no promised release dates. Validation comes before expanding the feature set.\n\n## Work tracker\n\nFilter by stage or area, or search for a feature. Statuses describe the current source; your browser does not change them.${data.board.some((item) => item.release === 'Unreleased') ? ' Cards marked **Unreleased** are implemented in source and absent from the latest public downloads.' : ''}\n\n<RoadmapBoard :roadmap="roadmap" />\n\n## Implemented on main\n\nThe repository includes these workflows. The latest public downloads are **${released}**${data.nextVersion ? `; items marked Unreleased are part of the work targeting **${data.nextVersion}**` : ''}.\n\n| Area | Implemented |\n| --- | --- |\n${data.available.map((item) => `| [${markdown(item.area)}](${item.href}) | ${markdown(item.text)} |`).join('\n')}\n\n## Integration status\n\n**Implemented** means an adapter exists in the current source. Provider behavior is tested with doubles; live smoke tests are still part of the next milestone. Features also depend on the selected model and agent setup.\n\n| Integration | Connection | Repository status | Capabilities |\n| --- | --- | --- | --- |\n${data.providers.map((p) => `| ${markdown(p.name)} | ${markdown(p.auth)} | ${markdown(p.status)} | ${markdown(p.capabilities)} |`).join('\n')}\n\nA2A and Webhook are declared as planned kinds and cannot be added yet. Codex is exploratory; Claude Code has no scheduled implementation.\n\n## Validation and limits\n\n${data.limits.map((item) => `- ${markdown(item)}`).join('\n')}\n\n## Release history\n\n${data.timeline.map((item) => `### ${markdown(item.v)}\n\n${markdown(item.what)}\n`).join('\n')}\n[Download releases](https://github.com/TinkerDoge/FoxFleet/releases) · [Read the changelog](./changelog) · [Release process](./release)\n\n## Help shape the next release\n\nTry an existing workflow on a real hub and [report a reproducible issue](https://github.com/TinkerDoge/FoxFleet/issues). Device, Docker, provider, and accessibility reports help close the current validation milestone. See [Contributing](./contributing) for development checks.\n\n<small>Reviewed ${data.updated}. [Roadmap source](https://github.com/TinkerDoge/FoxFleet/blob/main/docs/roadmap.html). The docs build checks release/source metadata and provider status against the repository.</small>\n`;
  out('project/roadmap.md', page);
}
