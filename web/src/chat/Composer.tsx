import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import type { AgentSummary } from '../api/types';
import { commandSuggestions, localCommandFor, type LocalCommand, type Suggestion } from '../lib/commands';
import { downscaleImage, isImageFile } from '../lib/images';
import { MAX_FILE_BYTES, humanSize, type FileRef } from '../lib/files';
import { estimatedBytes, HUB_BODY_LIMIT, type UiImage, type UiMessage } from '../lib/chat';
import { t } from '../i18n/t';

type Pending =
  | { id: number; kind: 'image'; dataUrl: string; name: string }
  | { id: number; kind: 'file'; name: string; size: number; progress: number; ref?: FileRef; error?: string; abort: AbortController };

const SR: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : undefined;
let nextId = 1;

export function Composer(props: {
  client: Client; agent: AgentSummary; history: UiMessage[]; streaming: boolean; skills: string[]; draftKey: string;
  onSend: (text: string, images: UiImage[], files: FileRef[]) => void; onStop: () => void; onLocal: (c: LocalCommand) => void;
}) {
  const { client, agent, streaming, skills } = props;
  const caps = agent.capabilities ?? {};
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [menu, setMenu] = useState(false), [sel, setSel] = useState(0), [note, setNote] = useState<string | null>(null), [drag, setDrag] = useState(false), [listening, setListening] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null), recog = useRef<any>(null), photo = useRef<HTMLInputElement>(null), cam = useRef<HTMLInputElement>(null), file = useRef<HTMLInputElement>(null);
  useEffect(() => { setText(''); setPending([]); setNote(null); }, [props.draftKey]);
  useEffect(() => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 168) + 'px'; } }, [text]);
  const suggestions = useMemo(() => commandSuggestions(text, skills, 8, agent.kind === 'hermes'), [text, skills, agent.kind]);
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
        .then((ref) => setPending((p) => p.map((x) => (x.id === id && x.kind === 'file' ? { ...x, ref, progress: 1 } : x))))
        .catch((e) => { if (e?.name !== 'AbortError') setPending((p) => p.map((x) => (x.id === id && x.kind === 'file' ? { ...x, error: String(e?.message ?? 'Upload failed') } : x))); });
    }
  }
  const route = (files: File[]) => { const imgs = files.filter(isImageFile), rest = files.filter((f) => !isImageFile(f)); if (imgs.length) void addImages(imgs); if (rest.length) addFiles(rest); };

  const images = pending.filter((p): p is Extract<Pending, { kind: 'image' }> => p.kind === 'image');
  const fileRefs = pending.filter((p): p is Extract<Pending, { kind: 'file' }> => p.kind === 'file');
  const uploading = fileRefs.some((f) => !f.ref && !f.error);
  const draftHistory: UiMessage[] = [...props.history, { role: 'user', content: text, images: images.map((i) => ({ dataUrl: i.dataUrl })) }];
  const tooBig = estimatedBytes(draftHistory) > HUB_BODY_LIMIT;
  const canSend = !streaming && !uploading && !tooBig && (text.trim().length > 0 || images.length > 0 || fileRefs.some((f) => f.ref));

  function submit() {
    const local = localCommandFor(text);
    if (local) { setText(''); props.onLocal(local); return; }
    if (!canSend) return;
    props.onSend(text.trim(), images.map((i) => ({ dataUrl: i.dataUrl })), fileRefs.flatMap((f) => (f.ref ? [f.ref] : [])));
    setText(''); setPending([]); setNote(null); setMenu(false);
  }
  function pick(s: Suggestion) { if (s.local) { setText(''); props.onLocal(s.local); } else { setText(s.insert); ta.current?.focus(); } setMenu(false); }
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
          {suggestions.map((s, i) => <li key={s.label} role="option" aria-selected={i === sel} class={i === sel ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(s); }}><b>{s.label}</b><small>{s.hint}</small></li>)}
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
        {SR && caps.voice !== false && !text.trim() && !streaming && <button class={`icon-btn mic${listening ? ' on' : ''}`} aria-label={listening ? t('chat.stopVoice') : t('chat.voice')} aria-pressed={listening} onClick={toggleVoice}>🎤</button>}
        {streaming
          ? <button class="send stop" aria-label={t('chat.stop')} onClick={props.onStop}>■</button>
          : <button class="send" aria-label={t('chat.send')} disabled={!canSend && !localCommandFor(text)} onClick={submit}>↑</button>}
      </div>
      {drag && <div class="drop-hint" aria-hidden="true">{t('chat.drop')}</div>}
    </div>
  );
}
