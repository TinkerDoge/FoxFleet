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
  online: boolean; chatReady: boolean; capabilities?: Partial<Capabilities>;
}
export interface Capabilities { chat: boolean; images: boolean; files: boolean; screen: boolean; voice: boolean; skills: boolean; sessions: boolean; mailbox: boolean }
export interface SessionInfo { id: string; title?: string }
