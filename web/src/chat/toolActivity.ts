import type { IconName } from '../components/Icon';
import { t } from '../i18n/t';
export interface ToolEvent { type: 'tool.start' | 'tool.progress' | 'tool.end'; turn_id?: string; tool_id?: string; name: string }
export interface ToolActivity { active: (ToolEvent & { key: string })[]; ended: string[] }
/** Active calls keyed by turn and call id: overlapping calls stay separate, and a replayed start after its end is ignored. */
export function updateTools(old: ToolActivity = { active: [], ended: [] }, event: ToolEvent): ToolActivity {
  const key = `${event.turn_id ?? ''}:${event.tool_id || 'legacy'}`;
  if (event.type === 'tool.end') return { active: old.active.filter(t => t.key !== key), ended: [...old.ended.filter(k => k !== key), key].slice(-1024) };
  if (old.ended.includes(key)) return old;
  return { active: [...old.active.filter(t => t.key !== key), { ...event, key }].slice(-32), ended: old.ended };
}
/** One safe, short line per tool: never raw arguments, paths or results. */
export function toolPresentation(name: string): { icon: IconName; label: string } {
  const n = name.toLowerCase();
  if (/search|browse|web|fetch/.test(n)) return { icon: 'search', label: t('tool.search') };
  if (/read|open_file|view/.test(n)) return { icon: 'file', label: t('tool.read') };
  if (/write|edit|patch/.test(n)) return { icon: 'file', label: t('tool.write') };
  if (/terminal|exec|shell|command|run/.test(n)) return { icon: 'bolt', label: t('tool.command') };
  if (/image|photo|vision/.test(n)) return { icon: 'image', label: t('tool.image') };
  return { icon: 'tool', label: /^[a-zA-Z][a-zA-Z0-9_ .-]{0,50}$/.test(name) ? t('tool.named', { tool: name.replace(/_/g, ' ') }) : t('tool.generic') };
}
