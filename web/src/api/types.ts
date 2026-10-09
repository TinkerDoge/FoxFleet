export type Registration = 'closed' | 'invite' | 'open';
export interface AuthInfo {
  required: boolean;
  authenticated: boolean;
  setupRequired: boolean;
  setupCodeRequired: boolean;
  registration: Registration;
  termsVersion?: string;
  user?: { id: string; username: string; role: 'owner' | 'user' };
}
export interface AgentSummary {
  id: string; name: string; displayName?: string; kind: string; description?: string;
  online: boolean; chatReady: boolean; capabilities?: Partial<Capabilities>;
}
export interface Capabilities { chat: boolean; images: boolean; files: boolean; screen: boolean; voice: boolean; skills: boolean; sessions: boolean; mailbox: boolean }
export interface SessionInfo { id: string; title?: string; updated?: number; preview?: string; messages?: number; pinned?: boolean }
export interface SessionPage { sessions: SessionInfo[]; total: number }
export interface HistoryPage { messages: import('../lib/chat').UiMessage[]; hasMore: boolean }
export interface Device { id: string; name: string; kind: string; created: number; lastSeen: number; current: boolean }
export interface AdminUser { id: string; username: string; role: 'owner' | 'user'; disabled: boolean }
export interface Invite { id: string; created?: number; expires: number; used: boolean }
export interface Shareable { link: string; hub?: string; id?: string; expires?: number; rows: string[] | null }
export interface MachineProfile { profile: string; agent: string }
export interface Machine { id: string; name: string; os: string; online: boolean; paired: boolean; created: number; lastSeen: number | null; profiles: MachineProfile[] }
export interface Pairing { code: string; display: string; expires: number; url: string; link: string; rows: string[] | null; commands: { sh: string; powershell: string; node: string } }
export type PairingState = { state: 'waiting' | 'expired' } | { state: 'paired'; machine?: Machine };
export interface ScreenStatus { running: boolean; supported: boolean; blocker: string | null; lease: { holder: string; epoch: number } | null }
export interface ScreenTicket { ticket: string; expiresInMs: number }
