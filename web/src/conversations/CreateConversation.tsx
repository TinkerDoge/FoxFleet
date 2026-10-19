import { useState } from 'preact/hooks';
import type { Client } from '../api/client';
import type { AgentSummary } from '../api/types';
import { Icon } from '../components/Icon';
import { Field, PrimaryButton } from '../components/ui';
import { navigate } from '../router';
import { t } from '../i18n/t';
import { createRoom, useConversations } from './store';

export function CreateConversation({ client, agents, onAuthLost }: { client: Client; agents: AgentSummary[] | null; onAuthLost: () => void }) {
  const [title, setTitle] = useState(''), [picked, setPicked] = useState<string[]>([]), [busy, setBusy] = useState(false);
  const s = useConversations();
  const toggle = (name: string) => setPicked((list) => (list.includes(name) ? list.filter((x) => x !== name) : [...list, name]));
  async function submit(e: Event) {
    e.preventDefault(); if (!title.trim() || busy) return;
    setBusy(true);
    const room = await createRoom(client, title, picked, onAuthLost);
    setBusy(false);
    if (room) navigate('conversations', { id: room.id });
  }
  return (
    <section class="rooms page">
      <header class="page-head"><button type="button" class="icon-btn" aria-label={t('rooms.back')} onClick={() => navigate('conversations')}><Icon name="back" /></button><h1>{t('rooms.new')}</h1></header>
      <form class="stack room-form" onSubmit={submit}>
        <Field label={t('rooms.titleLabel')} value={title} onInput={setTitle} name="room-title" autoFocus hint={t('rooms.titleHint')} />
        <fieldset class="field">
          <legend>{t('rooms.members')}</legend>
          <p class="muted small">{t('rooms.membersHint')}</p>
          {agents === null && <p class="muted small">{t('home.loading')}</p>}
          {agents?.length === 0 && <p class="muted small">{t('rooms.noAgents')}</p>}
          <ul class="pick-list">
            {(agents ?? []).map((a) => <li key={a.name}>
              <label class="pick-row">
                <input type="checkbox" checked={picked.includes(a.name)} onChange={() => toggle(a.name)} />
                <span class="grow"><b>{a.displayName || a.name}</b><small class="muted">{a.name}{a.online ? '' : ` · ${t('chat.offline')}`}</small></span>
                <span class={`dot ${a.online ? 'on' : 'off'}`} aria-hidden="true" />
              </label>
            </li>)}
          </ul>
        </fieldset>
        {s.error && <p class="error" role="alert">{s.error}</p>}
        <PrimaryButton type="submit" busy={busy} disabled={!title.trim()}>{t('rooms.create')}</PrimaryButton>
      </form>
    </section>
  );
}
