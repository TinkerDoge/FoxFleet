/** Which message a Bot Screen failure gets. Mirrors android ScreenProblems.kt; both are checked against contract/screen-problems.vectors.json. */
export type ScreenProblemKind = 'auth_expired' | 'hub_unreachable' | 'machine_offline' | 'hermes_too_old' | 'not_installed' | 'no_vnc' | 'blocked' | 'dashboard_unreachable' | 'timeout' | 'reopen' | 'hub_too_old' | 'viewer_failed' | 'empty_desktop' | 'no_picture' | 'generic';
export interface ScreenProblemInput { status?: number; code?: string; state?: string; network?: boolean; /** false when /api/auth had no hub block (a hub older than 0.3.5) */ hubKnown?: boolean }
export interface ScreenProblem { kind: ScreenProblemKind; update: boolean }

export function screenProblem(i: ScreenProblemInput): ScreenProblem {
  const old = i.hubKnown === false;
  const mk = (kind: ScreenProblemKind, update = false): ScreenProblem => ({ kind, update });
  if (i.state === 'empty') return mk('empty_desktop');
  if (i.state === 'no_picture') return mk('no_picture');
  if (i.network) return mk('hub_unreachable');
  if (i.status === 401) return mk('auth_expired');
  if (i.code === 'machine_offline') return mk('machine_offline');
  if (i.code === 'display_unsupported') return mk('hermes_too_old');
  if (i.state === 'not_installed') return mk('not_installed');
  if (i.state === 'no_vnc') return mk('no_vnc');
  if (i.state === 'blocked') return mk('blocked');
  if (i.code === 'gateway_unreachable' || i.code === 'dashboard_auth') return mk('dashboard_unreachable');
  if (i.code === 'timeout') return mk('timeout');
  if (i.code === 'reopen') return mk('reopen');
  if (i.status === 404) return mk('hub_too_old', true); // the route itself is missing: a hub that predates Bot Screen
  return mk('generic', old);
}
