import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import type { Conversation } from '../api/types';
import { Icon } from '../components/Icon';
import { navigate } from '../router';
import { listTime } from '../lib/agentList';
import { t } from '../i18n/t';
import { loadConversations, useConversations } from './store';

const memberNames = (c: Conversation) => c.members.map((m) => m.name).join(', ');

export function ConversationList({ client, onAuthLost, selectedId }: { client: Client; onAuthLost: () => void; selectedId?: string }) {
  const s = useConversations(), [q, setQ] = useState('');
  useEffect(() => { void loadConversations(client, onAuthLost); }, [client]);
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => (needle ? s.list.filter((c) => `${c.title} ${memberNames(c)}`.toLowerCase().includes(needle)) : s.list), [s.list, needle]);
  return (
    <section class="rooms" aria-label={t('rooms.title')}>
      <header class="rooms-head">
        <div class="grow"><h1>{t('rooms.title')}</h1><small class="muted">{t('rooms.subtitle')}</small></div>
        <button type="button" class="btn primary inline" onClick={() => navigate('conversations', { new: '1' })}><Icon name="add" size={18} />{t('rooms.new')}</button>
      </header>
      <label class="search rooms-search"><Icon name="search" size={18} /><input type="search" value={q} placeholder={t('rooms.search')} aria-label={t('rooms.search')} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} /></label>
      {s.error && <div class="card" role="alert"><p class="error">{s.error}</p><button type="button" class="btn text" onClick={() => void loadConversations(client, onAuthLost)}>{t('home.retry')}</button></div>}
      {s.loading && s.list.length === 0 && <p class="muted pad">{t('home.loading')}</p>}
      {!s.loading && !s.error && shown.length === 0 && (
        <div class="empty-home rooms-empty"><Icon name="users" size={48} class="icon-hero" /><h2>{needle ? t('rooms.noMatch') : t('rooms.empty')}</h2><p class="muted">{needle ? t('rooms.noMatchHint') : t('rooms.emptyHint')}</p>
          {!needle && <button type="button" class="btn primary inline" onClick={() => navigate('conversations', { new: '1' })}>{t('rooms.createFirst')}</button>}</div>
      )}
      {shown.length > 0 && <ul class="rooms-list" aria-label={t('rooms.list')}>
        {shown.map((c) => {
          const unread = c.unread_count ?? 0;
          return <li key={c.id} class={`room-row${selectedId === c.id ? ' active' : ''}${unread ? ' unread' : ''}`} data-room-id={c.id}>
            <a href={`#/conversations?id=${encodeURIComponent(c.id)}`} aria-current={selectedId === c.id ? 'page' : undefined}>
              <span class="room-avatar" aria-hidden="true"><Icon name="users" size={20} /></span>
              <span class="row-body">
                <span class="row-top"><span class="row-name">{c.title}</span><time class="row-time">{listTime(c.last_message_at ?? c.updated_at)}</time></span>
                <span class="row-bottom"><span class="row-preview">{memberNames(c) || t('rooms.noMembers')}</span>{unread > 0 && <span class="badge" role="img" aria-label={t('list.unread')} />}</span>
              </span>
            </a>
          </li>;
        })}
      </ul>}
    </section>
  );
}
