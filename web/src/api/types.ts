export type Registration = 'closed' | 'invite' | 'open';
export interface AuthInfo {
  required: boolean;
  authenticated: boolean;
  setupRequired: boolean;
  setupCodeRequired: boolean;
  registration: Registration;
  termsVersion?: string;
  /** Absent on a hub older than 0.3.5: clients then say "update your hub" instead of failing silently. */
  hub?: { version: string; features: string[] };
  user?: { id: string; username: string; role: 'owner' | 'user' };
}
export interface AgentSummary {
  id: string; name: string; displayName?: string; kind: string; description?: string;
  online: boolean; chatReady: boolean; capabilities?: Partial<Capabilities>;
  order?: number; avatar?: string | null;
  /** The agent list line (per signed-in user): see contract/openapi.json. */
  last_activity_at?: number | null; last_session_title?: string | null; last_message_preview?: string | null; last_role?: 'user' | 'assistant' | null;
  pinned?: boolean; pin_order?: number | null; working?: boolean; needs_input?: boolean;
}
export interface Capabilities { chat: boolean; images: boolean; files: boolean; screen: boolean; voice: boolean; skills: boolean; sessions: boolean; busy?: ('queue' | 'steer' | 'interrupt')[]; nativeRuns?: boolean; nativeUi?: boolean; reactions?: boolean; agentReactions?: boolean }
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
export interface ScreenStatus { state?: 'ok' | 'stopped' | 'no_vnc' | 'not_installed' | 'blocked'; missing?: string[]; running: boolean; supported: boolean; blocker: string | null; lease: { holder: string; epoch: number } | null }
export interface ScreenTicket { ticket: string; expiresInMs: number }

/** A group room is its own thing, never an AgentSummary (rooms have members, not one agent). */
export interface ConversationMember { id: string; name: string; kind: 'human' | 'agent'; is_bot: boolean; joined_at?: number }
export interface Conversation {
  id: string; thread_id: string; chat_type: 'group'; title: string;
  owner: ConversationMember; members: ConversationMember[]; created_at: number; updated_at: number;
  archived?: boolean; unread_count?: number; last_message_at?: number | null; paused?: boolean; epoch?: number;
}
export interface ConversationMention { kind: 'agent'; id: string; offset: number; length: number }
export interface ConversationMedia { id: string; kind: 'image' | 'video' | 'audio' | 'file'; mime: string; name: string; size: number; sha256?: string }
export interface ConversationMessage {
  id: string; conversation_id: string; sender: ConversationMember; text: string; created_at: number;
  reply_to?: string | null; mentions?: ConversationMention[]; edited?: boolean; media?: ConversationMedia[];
  system?: boolean; code?: string | null; delivery_state?: string | null; dispatch_id?: string | null; root_id?: string | null;
  seq?: number; deleted?: boolean;
}
export interface ConversationMessagePage { messages: ConversationMessage[]; has_more: boolean; next_cursor?: number | null; total?: number }
export interface ConversationList { conversations: Conversation[]; total?: number }
export interface ConversationPreferences { muted?: boolean; notify?: 'all' | 'mentions' | 'none'; archived?: boolean; pinned?: boolean }
export interface ConversationStopResult { stopped: boolean; confirmed: boolean; state?: 'stopped' | 'idle' | 'running'; epoch?: number; paused?: boolean }
