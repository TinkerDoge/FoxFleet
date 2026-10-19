import { useState } from 'preact/hooks';
import type { Client } from '../api/client';
import type { AgentSummary, Conversation, ConversationMember } from '../api/types';
import { Icon } from '../components/Icon';
import { Field } from '../components/ui';
import { t } from '../i18n/t';
import { addRoomMember, markRoomRead, removeRoomMember, renameRoom, setRoomPreferences, roomView } from './store';

export function ConversationDetails({ client, conversation, me, agents, onAuthLost, onClose }: {
  client: Client; conversation: Conversation; me?: ConversationMember; agents: AgentSummary[] | null; onAuthLost: () => void; onClose: () => void;
}) {
  const room = roomView(conversation.id), prefs = room.preferences ?? {};
  const [title, setTitle] = useState(conversation.title), [busy, setBusy] = useState(false), [add, setAdd] = useState('');
  const owner = Boolean(me && conversation.owner.id === me.id);
  const candidates = (agents ?? []).filter((a) => !conversation.members.some((m) => m.id === `agent:${a.name}` || m.name === a.name));
  async function saveTitle() {
    const next = title.trim(); if (!next || next === conversation.title || busy) return;
    setBusy(true); await renameRoom(client, conversation.id, next, onAuthLost); setBusy(false);
  }
  async function addMember() {
    if (!add || busy) return;
    setBusy(true); await addRoomMember(client, conversation.id, add, onAuthLost); setBusy(false); setAdd('');
  }
  return (
    <aside class="room-details" role="dialog" aria-label={t('rooms.details')} aria-modal="false">
      <header class="page-head"><h2>{t('rooms.details')}</h2><button type="button" class="icon-btn" aria-label={t('nav.closeMenu')} onClick={onClose}><Icon name="close" /></button></header>
      {room.error && <p class="error" role="alert">{room.error}</p>}
      <section class="room-detail-section">
        <Field label={t('rooms.titleLabel')} value={title} onInput={setTitle} name="room-title" disabled={!owner} />
        {owner && title.trim() && title.trim() !== conversation.title && <button type="button" class="btn text" disabled={busy} onClick={() => void saveTitle()}>{t('rooms.saveTitle')}</button>}
      </section>
      <section class="room-detail-section">
        <h3>{t('rooms.members')}</h3>
        <ul class="member-list">
          <li><span class="room-avatar small" aria-hidden="true"><Icon name="user" size={16} /></span><span class="grow"><b>{conversation.owner.name}</b><small class="muted">{t('rooms.owner')}</small></span></li>
          {conversation.members.map((m) => <li key={m.id}><span class="room-avatar small agent" aria-hidden="true"><Icon name="agents" size={16} /></span><span class="grow"><b>{m.name}</b><small class="muted">{t('rooms.agent')}</small></span>
            {owner && <button type="button" class="btn text danger" aria-label={t('rooms.removeNamed', { name: m.name })} onClick={() => void removeRoomMember(client, conversation.id, m.name, onAuthLost)}>{t('rooms.remove')}</button>}</li>)}
        </ul>
        {owner && <div class="row room-add">
          <select aria-label={t('rooms.addMember')} value={add} onChange={(e) => setAdd((e.currentTarget as HTMLSelectElement).value)}>
            <option value="">{t('rooms.chooseAgent')}</option>
            {candidates.map((a) => <option key={a.name} value={a.name}>{a.displayName || a.name}</option>)}
          </select>
          <button type="button" class="btn text" disabled={!add || busy} onClick={() => void addMember()}>{t('rooms.add')}</button>
        </div>}
      </section>
      <section class="room-detail-section">
        <h3>{t('rooms.notifications')}</h3>
        <label class="pick-row"><input type="checkbox" checked={prefs.muted === true} onChange={(e) => void setRoomPreferences(client, conversation.id, { muted: (e.currentTarget as HTMLInputElement).checked }, onAuthLost)} /><span class="grow">{t('rooms.mute')}</span></label>
        <label class="field"><span>{t('rooms.notifyLevel')}</span><select value={prefs.notify ?? 'all'} onChange={(e) => void setRoomPreferences(client, conversation.id, { notify: (e.currentTarget as HTMLSelectElement).value as 'all' | 'mentions' | 'none' }, onAuthLost)}>
          <option value="all">{t('rooms.notifyAll')}</option><option value="mentions">{t('rooms.notifyMentions')}</option><option value="none">{t('rooms.notifyNone')}</option>
        </select></label>
        <button type="button" class="btn text" onClick={() => void markRoomRead(client, conversation.id, onAuthLost)}><Icon name="seen" size={16} />{t('rooms.markRead')}</button>
      </section>
    </aside>
  );
}
