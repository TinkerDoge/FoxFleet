import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Client, SendMode } from '../api/client';
import type { AgentSummary } from '../api/types';
import { BUNDLED_CATALOG, LOCAL_CATALOG, commandSuggestions, parseHub, parseLocal, unavailableReason, type Catalog, type LocalCommand, type Suggestion } from '../lib/commands';
import { loadMode, saveMode } from '../lib/persist';
import type { QueueItem } from './store';
import { downscaleImage, isImageFile } from '../lib/images';
import { MAX_FILE_BYTES, humanSize, type FileRef } from '../lib/files';
import { estimatedBytes, HUB_BODY_LIMIT, type UiImage, type UiMessage } from '../lib/chat';
import { t } from '../i18n/t';
type K = Parameters<typeof t>[0];
import { useDraft, type PendingAttachment as Pending } from './drafts';

const SR: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : undefined;
let nextId = 1;
const catalogs = new Map<string, Catalog>();
const MODES: SendMode[] = ['queue', 'steer', 'interrupt'];
/** The remembered mode of this conversation (else of this agent), limited to what the agent supports; Hermes defaults to Interrupt & send. */
export function pickMode(agent: string, session: string | undefined, kind: string, modes: SendMode[]): SendMode {
  const saved = loadMode(agent, session) ?? loadMode(agent, undefined);
  if (saved && modes.includes(saved as SendMode)) return saved as SendMode;
  return kind === 'hermes' && modes.includes('interrupt') ? 'interrupt' : 'queue';
}

export function Composer(props: {
  client: Client; agent: AgentSummary; history: UiMessage[]; streaming: boolean; skills: string[]; draftKey: string; session?: string; queue?: QueueItem[]; onCancelQueued?: (id: string) => void;
  onSend: (text: string, images: UiImage[], files: FileRef[], mode: SendMode) => void; onStop: () => void; onLocal: (c: LocalCommand, args?: string) => void;
}) {
  const { client, agent, streaming, skills } = props;
  const caps = agent.capabilities ?? {};
  const isHermes = agent.kind === 'hermes', queue = props.queue ?? [];
  const modes = ((caps.busy ?? ['queue']) as SendMode[]).filter((m) => MODES.includes(m));
  const [mode, setModeState] = useState<SendMode>(() => pickMode(agent.name, props.session, agent.kind, modes));
  const setMode = (m: SendMode) => { setModeState(m); saveMode(agent.name, props.session, m); saveMode(agent.name, undefined, m); };
  const [catalog, setCatalog] = useState<Catalog>(() => catalogs.get(agent.name) ?? (isHermes ? BUNDLED_CATALOG : LOCAL_CATALOG));
  useEffect(() => { let on = true; void Promise.resolve().then(() => client.commands(agent.name)).then((c) => { if (!on || (c.source === 'bundled' && !isHermes)) return; catalogs.set(agent.name, c); setCatalog(c); }).catch(() => {}); return () => { on = false; }; }, [agent.name]);
  const [{ text, pending }, setDraft] = useDraft(props.draftKey);
  const setText = (text: string) => setDraft((draft) => ({ ...draft, text }));
  const setPending = (update: Pending[] | ((pending: Pending[]) => Pending[])) => setDraft((draft) => ({ ...draft, pending: typeof update === 'function' ? update(draft.pending) : update }));
  const [menu, setMenu] = useState(false), [sel, setSel] = useState(0), [note, setNote] = useState<string | null>(null), [drag, setDrag] = useState(false), [listening, setListening] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null), recog = useRef<any>(null), photo = useRef<HTMLInputElement>(null), cam = useRef<HTMLInputElement>(null), file = useRef<HTMLInputElement>(null);
  useEffect(() => () => recog.current?.abort(), []);
  useEffect(() => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 168) + 'px'; } }, [text]);
  const suggestions = useMemo(() => commandSuggestions(text, isHermes ? skills : [], 60, isHermes, catalog), [text, skills, agent.kind, catalog]);
  useEffect(() => setSel(0), [text]);

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

  function describeMode() { return t(('chat.mode.' + mode) as K); }
  function hubCommand(h: NonNullable<ReturnType<typeof parseHub>>) {
    const { cmd, args } = h, waiting = queue.filter((q) => q.state === 'queued' || q.state === 'awaiting_stop');
    if (h.command.executable === false) { setNote(`/${h.command.name}: ${h.command.disabledReason ?? t('chat.noSteer')}`); return; }
    if (cmd === 'busy') {
      if (!args || args === 'status') { setNote(`${t('chat.modeNow', { mode: describeMode() })} · ${waiting.length ? t('chat.queueCount', { n: waiting.length }) : t('chat.queueEmpty')}`); setText(''); return; }
      if (modes.includes(args as SendMode)) { setMode(args as SendMode); setNote(t('chat.modeNow', { mode: t(('chat.mode.' + args) as K) })); setText(''); return; }
      setNote(`/busy ${args}: ${args === 'steer' ? t('chat.noSteer') : modes.join(' | ') + ' | status'}`); return;
    }
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
  function pick(s: Suggestion) { if (s.kind === 'arg') { if (s.availability === 'unavailable') setNote(`${s.label}: ${s.reason}`); else { setText(s.insert); ta.current?.focus(); } setMenu(false); return; } if (s.availability === 'unavailable') { setNote(`${s.label}: ${s.reason ?? 'Not available remotely'}`); } else if (s.local && s.local !== 'title') { setText(''); props.onLocal(s.local); } else { setText(s.insert); ta.current?.focus(); } setMenu(false); }
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
      {menu && suggestions.length > 0 && (
        <ul class="suggest" role="listbox" aria-label={t('chat.commands')}>
          {suggestions.map((s, i) => <>{s.group && s.group !== suggestions[i - 1]?.group && <li role="presentation" class="grp">{s.group}</li>}<li key={s.label} role="option" aria-selected={i === sel} aria-disabled={s.availability === 'unavailable' ? 'true' : undefined} class={`${i === sel ? 'on' : ''}${s.availability === 'unavailable' ? ' off' : ''}`} onMouseDown={(e) => { e.preventDefault(); pick(s); }}><b>{s.label}{s.args && <em> {s.args}</em>}</b><small>{s.hint}</small></li></>)}
        </ul>
      )}
      {pending.length > 0 && (
        <div class="attachments">
          {pending.map((p) => p.kind === 'image'
            ? <div class="att" key={p.id}><img src={p.dataUrl} alt={p.name} /><button aria-label={t('chat.remove')} onClick={() => setPending((x) => x.filter((y) => y.id !== p.id))}>✕</button></div>
            : <div class={`att file${p.error ? ' bad' : ''}`} key={p.id}>
                <span class="chip-name">📎 {p.name}</span><small>{p.error ?? (p.ref ? humanSize(p.size) : `${Math.round(p.progress * 100)}%`)}</small>
                {!p.ref && !p.error && <progress max={1} value={p.progress} aria-label={t('chat.uploading')} />}
                <button aria-label={t('chat.remove')} onClick={() => { p.abort.abort(); setPending((x) => x.filter((y) => y.id !== p.id)); }}>✕</button>
              </div>)}
        </div>
      )}
      {(note || tooBig) && <p class="note" role="status">{tooBig ? t('chat.tooBig') : note}</p>}
      <div class="bar">
        {(caps.images || caps.files) && (
          <span class="attach">
            <button class="icon-btn" aria-label={t('chat.attach')} aria-haspopup="menu" onClick={(e) => { const m = (e.currentTarget.nextElementSibling as HTMLElement); m.hidden = !m.hidden; }}>＋</button>
            <div class="attach-menu" role="menu" hidden onClick={(e) => ((e.currentTarget as HTMLElement).hidden = true)}>
              {caps.images && <button role="menuitem" onClick={() => photo.current?.click()}>{t('chat.photo')}</button>}
              {caps.images && <button role="menuitem" onClick={() => cam.current?.click()}>{t('chat.camera')}</button>}
              {caps.files && <button role="menuitem" onClick={() => file.current?.click()}>{t('chat.file')}</button>}
            </div>
            <input ref={photo} type="file" accept="image/*" multiple hidden onChange={media} />
            <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={media} />
            <input ref={file} type="file" multiple hidden onChange={media} />
          </span>
        )}
        <textarea ref={ta} rows={1} value={text} placeholder={t('chat.placeholder', { agent: agent.displayName || agent.name })} aria-label={t('chat.message')}
          onInput={(e) => { setText((e.currentTarget as HTMLTextAreaElement).value); setMenu(true); }} onKeyDown={key} onBlur={() => setMenu(false)}
          onPaste={(e) => { const f = Array.from(e.clipboardData?.files ?? []); if (f.length) { e.preventDefault(); route(f); } }} />
        {SR && caps.voice !== false && !text.trim() && <button class={`icon-btn mic${listening ? ' on' : ''}`} aria-label={listening ? t('chat.stopVoice') : t('chat.voice')} aria-pressed={listening} onClick={toggleVoice}>🎤</button>}
        {(streaming || queue.length > 0) && modes.length > 1 && (
          <select class="mode" aria-label={t('chat.mode')} title={t(('chat.mode.' + mode + '.help') as K)} value={mode} onChange={(e) => setMode((e.currentTarget as HTMLSelectElement).value as SendMode)}>
            {modes.map((m) => <option key={m} value={m}>{t(('chat.mode.' + m) as K)}</option>)}
          </select>
        )}
        {streaming && <button class="send stop" aria-label={t('chat.stop')} onClick={props.onStop}>■</button>}
        <button class="send" aria-label={streaming ? `${t('chat.send')} · ${t(('chat.mode.' + mode) as K)}` : t('chat.send')} disabled={!canSend && !parseLocal(text, isHermes) && !parseHub(text, catalog)} onClick={submit}>↑</button>
      </div>
      {drag && <div class="drop-hint" aria-hidden="true">{t('chat.drop')}</div>}
    </div>
  );
}
