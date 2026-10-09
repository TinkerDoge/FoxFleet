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
export interface Device { id: string; name: string; kind: string; created: number; lastSeen: number; current: boolean }
export interface AdminUser { id: string; username: string; role: 'owner' | 'user'; disabled: boolean }
export interface Invite { id: string; created?: number; expires: number; used: boolean }
export interface Shareable { link: string; hub?: string; id?: string; expires?: number; rows: string[] | null }
export interface ScreenStatus { running: boolean; supported: boolean; blocker: string | null; lease: { holder: string; epoch: number } | null }
export interface ScreenTicket { ticket: string; expiresInMs: number }
