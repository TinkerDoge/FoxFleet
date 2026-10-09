import { ICON_PATHS, ICON_VIEWBOX, type IconName } from '../icons/paths';

/** Rounded icon (Material Symbols Rounded, bundled locally). Decorative unless `label` is given. */
export function Icon({ name, size = 20, label, class: cls }: { name: IconName; size?: number; label?: string; class?: string }) {
  return (
    <svg class={`icon${cls ? ' ' + cls : ''}`} width={size} height={size} viewBox={ICON_VIEWBOX} fill="currentColor" focusable="false"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' })}>
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
export type { IconName };
