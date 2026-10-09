import type { AuthInfo } from '../api/types';
export type AuthMode = 'signin' | 'setup' | 'join';
/** Same rules as the Android authModeFor: setup wins, join only when registration allows it and the user asked. */
export function authModeFor(info: Pick<AuthInfo, 'setupRequired' | 'registration'>, wantsJoin: boolean): AuthMode {
  if (info.setupRequired) return 'setup';
  if (wantsJoin && info.registration !== 'closed') return 'join';
  return 'signin';
}
