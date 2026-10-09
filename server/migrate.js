// One-time v1 → v2 registry migration. v1 configs were a bare {machines:[…]} list of Hermes installs
// (older Hermes-only hubs); v2 is {version:2, machines:[…]} where order is the
// list order and each agent carries its own label/description. Runs once at hub start, keeps a backup.
import { copyFile } from 'node:fs/promises';

export const REGISTRY_VERSION = 3;

export const needsMigration = (raw) => raw?.version !== REGISTRY_VERSION;

export function migrateMachines(machines) {
  return machines.map((m) => {
    const out = { ...m };
    if (!out.kind) out.kind = 'hermes';
    // v3: Hermes entries without an explicit mode are direct; OpenAI-compatible entries pointing at known providers become their plugin.
    if (out.kind === 'hermes' && !out.connection) out.connection = 'direct';
    if (out.kind === 'openai' && typeof out.baseUrl === 'string') {
      try {
        const host = new URL(out.baseUrl).hostname;
        if (host === 'openrouter.ai') out.kind = 'openrouter';
        else if (host === 'api.z.ai') { out.kind = 'zai'; out.endpoint = /\/coding\//.test(out.baseUrl) ? 'coding' : 'general'; }
        else if (host === 'api.x.ai') out.kind = 'grok';
        else if (host === 'opencode.ai') out.kind = 'opencode';
      } catch {}
    }
    return out;
  });
}

export async function backup(configPath, from = 1) {
  const target = configPath + '.v' + from + '.bak';
  await copyFile(configPath, target, 1 /* COPYFILE_EXCL: never overwrite an earlier backup */).catch((e) => { if (e.code !== 'EEXIST') throw e; });
  return target;
}
