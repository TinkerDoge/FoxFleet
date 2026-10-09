export type Registration = 'closed' | 'invite' | 'open';
export interface AuthInfo {
  required: boolean;
  authenticated: boolean;
  setupRequired: boolean;
  setupCodeRequired: boolean;
  registration: Registration;
  user?: { id: string; username: string; role: 'owner' | 'user' };
}
export interface AgentSummary {
  id: string; name: string; displayName?: string; kind: string; description?: string;
  online: boolean; chatReady: boolean; capabilities?: Record<string, boolean>;
}
