// Avatar pack discovery: web/avatars/<Agent>/{idle,working,offline}.<ext> + optional poster.
// Rendered packs are optional; an agent without a pack keeps the built-in SVG fox.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { identifier } from './config.js';

export const AVATAR_STATES = ['idle', 'working', 'offline', 'making_something', 'milestone_level_up'];
const VIDEO_EXT = /\.(webm|mp4|m4v|mov)$/i;
const VIDEO_PREFERENCE = ['.webm', '.mp4', '.m4v', '.mov'];
const POSTERS = ['poster.png', 'poster.jpg', 'poster.webp', 'poster.avif'];
const MAX_AGENTS = 32;

function safeSegment(value) { return identifier(value); }

// Returns [{ agent, poster?, states: { idle: { src }, ... } }, ...]
export async function scanAvatarPacks(baseDir) {
  const packs = [];
  let agents;
  try { agents = await readdir(baseDir, { withFileTypes: true }); } catch { return packs; }
  for (const entry of agents.slice(0, MAX_AGENTS)) {
    if (!entry.isDirectory() || !safeSegment(entry.name)) continue;
    const dir = path.join(baseDir, entry.name);
    let files;
    try { files = await readdir(dir); } catch { continue; }
    const states = {};
    for (const file of files) {
      const match = VIDEO_EXT.exec(file);
      if (!match) continue;
      const state = file.slice(0, -match[0].length);
      if (!AVATAR_STATES.includes(state)) continue;
      // Prefer .webm, then .mp4 — first supported hit per state wins.
      const rank = VIDEO_PREFERENCE.indexOf(match[0].toLowerCase());
      const existing = states[state];
      if (!existing || rank < existing.rank) states[state] = { rank, src: `/avatars/${encodeURIComponent(entry.name)}/${encodeURIComponent(file)}` };
    }
    if (!Object.keys(states).length) continue;
    const posterFile = POSTERS.find((p) => files.includes(p));
    const pack = { agent: entry.name, states };
    if (posterFile) pack.poster = `/avatars/${encodeURIComponent(entry.name)}/${encodeURIComponent(posterFile)}`;
    for (const key of Object.keys(states)) delete states[key].rank; // strip internal rank before exposure
    packs.push(pack);
  }
  return packs;
}
