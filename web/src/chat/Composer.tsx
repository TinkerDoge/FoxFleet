import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Client, SendMode } from '../api/client';
import type { AgentSummary } from '../api/types';
import { BUNDLED_CATALOG, LOCAL_CATALOG, commandSuggestions, opensCommandBrowser, parseHub, parseLocal, resolveCommand, unavailableReason, type Catalog, type LocalCommand, type Suggestion } from '../lib/commands';
import { CommandBrowser } from './CommandBrowser';
import type { QueueItem } from './store';
import { downscaleImage, isImageFile } from '../lib/images';
import { MAX_FILE_BYTES, humanSize, type FileRef } from '../lib/files';
import { estimatedBytes, HUB_BODY_LIMIT, type UiImage, type UiMessage } from '../lib/chat';
import { t } from '../i18n/t';
import { useDraft, type PendingAttachment as Pending } from './drafts';
import { Icon } from '../components/Icon';
import { ActionMenu } from '../components/ActionMenu';

const SR: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : undefined;
let nextId = 1;
const catalogs = new Map<string, Catalog>();
/** What a plain message means while the agent works. Like Telegram/Discord there is no picker: Hermes applies its own profile setting (busy_input_mode) and says what it did; every other agent is stopped and the message sent. */
export function plainMode(native: boolean, modes: SendMode[]): SendMode { return native ? 'auto' : modes.includes('interrupt') ? 'interrupt' : 'queue'; }

export function Composer(props: {
  client: Client; agent: AgentSummary; history: UiMessage[]; streaming: boolean; skills: string[]; draftKey: string; session?: string; disabled?: boolean; queue?: QueueItem[]; onCancelQueued?: (id: string) => void;
  onSend: (text: string, images: UiImage[], files: FileRef[], mode: SendMode) => void; onStop: () => void; onLocal: (c: LocalCommand, args?: string) => void;
  onModel?: (args: string) => void; onChoices?: (command: string, options: string[]) => void;
}) {
  const { client, agent, streaming, skills } = props;
  const caps = agent.capabilities ?? {};
  const isHermes = agent.kind === 'hermes', queue = props.queue ?? [];
  const modes = ((caps.busy ?? ['queue']) as SendMode[]).filter((m) => ['queue', 'steer', 'interrupt'].includes(m));
  const cacheKey = `${agent.name}\0${props.session ?? ''}`;
  const [catalog, setCatalog] = useState<Catalog>(() => catalogs.get(cacheKey) ?? (isHermes ? BUNDLED_CATALOG : LOCAL_CATALOG));
  useEffect(() => { let on = true; setCatalog(catalogs.get(cacheKey) ?? (isHermes ? BUNDLED_CATALOG : LOCAL_CATALOG)); void Promise.resolve().then(() => client.commands(agent.name, props.session)).then((c) => { if (!on || (c.source === 'bundled' && !isHermes)) return; catalogs.set(cacheKey, c); setCatalog(c); }).catch(() => {}); return () => { on = false; }; }, [cacheKey, isHermes]);
  const [{ text, pending }, setDraft] = useDraft(props.draftKey);
  const setText = (text: string) => setDraft((draft) => ({ ...draft, text }));
  const setPending = (update: Pending[] | ((pending: Pending[]) => Pending[])) => setDraft((draft) => ({ ...draft, pending: typeof update === 'function' ? update(draft.pending) : update }));
  const [menu, setMenu] = useState(false), [browser, setBrowser] = useState(false), [sel, setSel] = useState(0), [note, setNote] = useState<string | null>(null), [drag, setDrag] = useState(false), [listening, setListening] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null), listRef = useRef<HTMLUListElement>(null), recog = useRef<any>(null), photo = useRef<HTMLInputElement>(null), cam = useRef<HTMLInputElement>(null), file = useRef<HTMLInputElement>(null);
  useEffect(() => () => recog.current?.abort(), []);
  useEffect(() => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 168) + 'px'; } }, [text]);
  const skillNames = useMemo(() => [...new Set([...(isHermes ? skills : []), ...(catalog.skills ?? [])])], [skills, catalog, isHermes]);
  const suggestions = useMemo(() => commandSuggestions(text, skillNames, Number.POSITIVE_INFINITY, isHermes, catalog), [text, skillNames, isHermes, catalog]);
  useEffect(() => setSel(0), [text]);
  useEffect(() => { const row = listRef.current?.querySelector('[aria-selected="true"]'); if (typeof row?.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' }); }, [sel, suggestions.length]);

  async function addImages(files: File[]) {
    if (!caps.images) { setNote(t('chat.noImages')); return; }
    for (const f of files.filter(isImageFile).slice(0, 4)) {
      try { const r = await downscaleImage(f); setPending((p) => (p.filter((x) => x.kind === 'image').length >= 4 ? p : [...p, { id: nextId++, kind: 'image', dataUrl: r.dataUrl, name: f.name }])); }
      catch (e) { setNote((e as Error).message); }
    }
  }
  function addFiles(files: File[]) {
    if (!caps.files) { setNote(t('chat.noFiles')); return; }
    for (const f of files.slice(0, 4)) {
      if (f.size <= 0) { setNote(t('chat.emptyFile')); continue; }
      if (f.size > MAX_FILE_BYTES) { setNote(t('chat.fileTooBig', { mb: MAX_FILE_BYTES / 1048576 })); continue; }
      const id = nextId++, abort = new AbortController();
      setPending((p) => [...p, { id, kind: 'file', name: f.name, size: f.size, progress: 0, abort }]);
      client.uploadFile(agent.name, f, (frac) => setPending((p) => p.map((x) => (x.id === id && x.kind === 'file' ? { ...x, progress: frac } : x))), abort.signal)
        .then((ref) => { if (!abort.signal.aborted) setPending((p) => p.map((x) => (x.id === id && x.kind === 'file' ? { ...x, ref, progress: 1 } : x))); })
        .catch((e) => { if (!abort.signal.aborted && e?.name !== 'AbortError') setPending((p) => p.map((x) => (x.id === id && x.kind === 'file' ? { ...x, error: String(e?.message ?? 'Upload failed') } : x))); });
    }
  }
  const route = (files: File[]) => { const imgs = files.filter(isImageFile), rest = files.filter((f) => !isImageFile(f)); if (imgs.length) void addImages(imgs); if (rest.length) addFiles(rest); };

  const images = pending.filter((p): p is Extract<Pending, { kind: 'image' }> => p.kind === 'image');
  const fileRefs = pending.filter((p): p is Extract<Pending, { kind: 'file' }> => p.kind === 'file');
  const uploading = fileRefs.some((f) => !f.ref && !f.error);
  const draftHistory: UiMessage[] = [...props.history, { role: 'user', content: text, images: images.map((i) => ({ dataUrl: i.dataUrl })) }];
  const tooBig = estimatedBytes(draftHistory) > HUB_BODY_LIMIT;
  const canSend = !uploading && !tooBig && (text.trim().length > 0 || images.length > 0 || fileRefs.some((f) => f.ref));

  const native = caps.nativeUi === true, mode = plainMode(native, modes);
  function hubCommand(h: NonNullable<ReturnType<typeof parseHub>>) {
    const { cmd, args } = h, waiting = queue.filter((q) => q.state === 'queued' || q.state === 'awaiting_stop');
    if (h.command.executable === false) { setNote(`/${h.command.name}: ${h.command.disabledReason ?? t('chat.noSteer')}`); return; }
    if (cmd === 'busy') { setNote(`${t('chat.busyCmd')}${waiting.length ? ' · ' + t('chat.queueCount', { n: waiting.length }) : ''}`); setText(''); return; }
    if (cmd === 'queue') {
      const sub = /^(list|rm|clear|add|edit|move)\b\s*([\s\S]*)$/.exec(args);
      if (sub && sub[1] === 'list') { setNote(waiting.length ? waiting.map((q, i) => `${i + 1}. ${q.text.slice(0, 40)}`).join('  ') : t('chat.queueEmpty')); setText(''); return; }
      if (sub && sub[1] === 'clear') { waiting.forEach((q) => props.onCancelQueued?.(q.id)); setText(''); return; }
      if (sub && sub[1] === 'rm') { const q = waiting[Number(sub[2]) - 1]; if (q) props.onCancelQueued?.(q.id); else setNote(t('chat.queueEmpty')); setText(''); return; }
      if (sub && (sub[1] === 'edit' || sub[1] === 'move')) { setNote(h.command.unavailableSubcommands?.[sub[1]] ?? ''); return; }
      const body = (sub && sub[1] === 'add' ? sub[2] : args).trim(); if (!body) { setNote(h.command.args); return; }
      sendBody(body, 'queue'); return;
    }
    if (!args) { setNote(h.command.args); return; }
    sendBody(args, 'steer');
  }
  function sendBody(body: string, m: SendMode) { setDraft({ text: '', pending: [] }); setNote(null); setMenu(false); props.onSend(body, [], [], m); }
  function submit() {
    if (props.disabled) return;
    if (isHermes && opensCommandBrowser(text)) { setText(''); setNote(null); setMenu(false); setBrowser(true); return; }
    const mm = /^\/model(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (native && mm && props.onModel) { setText(''); setNote(null); setMenu(false); props.onModel((mm[1] ?? '').trim()); return; }
    const bare = /^\/([A-Za-z0-9_-]+)$/.exec(text.trim()), bc = bare && native ? resolveCommand(bare[1], catalog) : undefined;
    if (bc && bc.subcommands.length > 1 && bc.executable !== false && !bc.handler?.startsWith('hub:') && bc.availability !== 'unavailable' && props.onChoices) { setText(''); setMenu(false); props.onChoices(bc.name, bc.subcommands); return; }
    const hub = parseHub(text, catalog); if (hub) { hubCommand(hub); return; }
    const local = parseLocal(text, isHermes);
    if (local) { setText(''); props.onLocal(local.cmd, local.args); return; }
    const blocked = unavailableReason(text, catalog);
    if (blocked) { setNote(`${text.trim().split(/\s/)[0]}: ${blocked}`); return; }
    if (!canSend) return;
    const out = { text: text.trim(), imgs: images.map((i) => ({ dataUrl: i.dataUrl })), refs: fileRefs.flatMap((f) => (f.ref ? [f.ref] : [])) };
    setDraft({ text: '', pending: [] }); setNote(null); setMenu(false); // clear first: the hub may assign the session id (and move the draft) while sending
    props.onSend(out.text, out.imgs, out.refs, mode);
  }
  function pick(s: Suggestion) {
    if (s.label === '/help' || s.label === '/palette') { setText(''); setNote(null); setMenu(false); setBrowser(true); return; }
    setBrowser(false);
    if (s.kind === 'arg') { if (s.availability === 'unavailable') setNote(`${s.label}: ${s.reason}`); else { setText(s.insert); ta.current?.focus(); } setMenu(false); return; }
    if (s.availability === 'unavailable') { setNote(`${s.label}: ${s.reason ?? 'Not available remotely'}`); } else if (s.local && s.local !== 'title') { setText(''); props.onLocal(s.local); } else { setText(s.insert); ta.current?.focus(); }
    setMenu(false);
  }
  function key(e: KeyboardEvent) {
    if (suggestions.length && menu) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pick(suggestions[sel]); return; }
      if (e.key === 'Escape') { setMenu(false); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  }
  function toggleVoice() {
    if (listening) { recog.current?.stop(); return; }
    const r = new SR(); r.interimResults = true; r.lang = navigator.language || 'en-US'; r.continuous = false;
    const base = text ? text + ' ' : '';
    r.onresult = (e: any) => setText(base + Array.from(e.results).map((x: any) => x[0].transcript).join(''));
    r.onend = () => setListening(false); r.onerror = () => setListening(false);
    recog.current = r; setListening(true); r.start();
  }
  const media = (e: Event) => { const f = Array.from((e.currentTarget as HTMLInputElement).files ?? []); (e.currentTarget as HTMLInputElement).value = ''; route(f); };

  return (
    <div class={`composer${drag ? ' dragging' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setDrag(true); } }} onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); route(Array.from(e.dataTransfer?.files ?? [])); }}>
      {browser && <CommandBrowser skills={skillNames} catalog={catalog} onClose={() => { setBrowser(false); ta.current?.focus(); }} onPick={pick} />}
      {menu && !browser && suggestions.length > 0 && (
        <ul class="suggest" role="listbox" aria-label={t('chat.commands')} ref={listRef}>
          {suggestions.map((s, i) => <>{s.group && s.group !== suggestions[i - 1]?.group && <li role="presentation" class="grp">{s.group}</li>}<li key={s.label} role="option" aria-selected={i === sel} aria-disabled={s.availability === 'unavailable' ? 'true' : undefined} class={`${i === sel ? 'on' : ''}${s.availability === 'unavailable' ? ' off' : ''}`} onMouseDown={(e) => { e.preventDefault(); pick(s); }}><b>{s.label}{s.args && <em> {s.args}</em>}</b><small>{s.hint}</small></li></>)}
        </ul>
      )}
      {pending.length > 0 && (
        <div class="attachments">
          {pending.map((p) => p.kind === 'image'
            ? <div class="att" key={p.id}><img src={p.dataUrl} alt={p.name} /><button aria-label={t('chat.remove')} onClick={() => setPending((x) => x.filter((y) => y.id !== p.id))}><Icon name="close" size={14} /></button></div>
            : <div class={`att file${p.error ? ' bad' : ''}`} key={p.id}>
                <Icon name="attach" size={16} /><span class="chip-name">{p.name}</span><small>{p.error ?? (p.ref ? humanSize(p.size) : `${Math.round(p.progress * 100)}%`)}</small>
                {!p.ref && !p.error && <progress max={1} value={p.progress} aria-label={t('chat.uploading')} />}
                <button aria-label={t('chat.remove')} onClick={() => { p.abort.abort(); setPending((x) => x.filter((y) => y.id !== p.id)); }}><Icon name="close" size={14} /></button>
              </div>)}
        </div>
      )}
      {(note || tooBig) && <p class="note" role="status">{tooBig ? t('chat.tooBig') : note}</p>}
      <div class="bar">
        {(caps.images || caps.files) && (
          <span class="attach">
            <ActionMenu label={t('chat.attach')} above actions={[
              ...(caps.images ? [{ label: t('chat.photo'), onSelect: () => photo.current?.click() }, { label: t('chat.camera'), onSelect: () => cam.current?.click() }] : []),
              ...(caps.files ? [{ label: t('chat.file'), onSelect: () => file.current?.click() }] : []),
            ]}><Icon name="add" size={22} /></ActionMenu>
            <input ref={photo} type="file" accept="image/*" multiple hidden onChange={media} />
            <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={media} />
            <input ref={file} type="file" multiple hidden onChange={media} />
          </span>
        )}
        <textarea ref={ta} rows={1} value={text} placeholder={t('chat.placeholder', { agent: agent.displayName || agent.name })} aria-label={t('chat.message')}
          onInput={(e) => { setText((e.currentTarget as HTMLTextAreaElement).value); setMenu(true); }} onKeyDown={key} onBlur={() => setMenu(false)}
          onPaste={(e) => { const f = Array.from(e.clipboardData?.files ?? []); if (f.length) { e.preventDefault(); route(f); } }} />
        {SR && caps.voice !== false && !text.trim() && <button class={`icon-btn mic${listening ? ' on' : ''}`} aria-label={listening ? t('chat.stopVoice') : t('chat.voice')} aria-pressed={listening} onClick={toggleVoice}>{<Icon name="mic" size={22} />}</button>}
        {streaming && <button class="send stop" aria-label={t('chat.stop')} onClick={props.onStop}>{<Icon name="stop" size={22} />}</button>}
        <button class="send" aria-label={t('chat.send')} disabled={props.disabled || (!canSend && !parseLocal(text, isHermes) && !parseHub(text, catalog))} onClick={submit}><Icon name="send" size={22} /></button>
      </div>
      {drag && <div class="drop-hint" aria-hidden="true">{t('chat.drop')}</div>}
    </div>
  );
}
