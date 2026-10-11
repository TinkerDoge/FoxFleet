import { useEffect, useRef } from 'preact/hooks';
import { LIMITS, PATTERNS, SOLIDS, isDefault, patternUrl, solidVar, type BgMode, type ChatBg } from '../lib/chatBg';
import { Icon } from '../components/Icon';
import { t } from '../i18n/t';

const MODES: { mode: BgMode; label: 'chatbg.default' | 'chatbg.solid' | 'chatbg.pattern' | 'chatbg.image' }[] = [
  { mode: 'default', label: 'chatbg.default' }, { mode: 'solid', label: 'chatbg.solid' }, { mode: 'pattern', label: 'chatbg.pattern' }, { mode: 'image', label: 'chatbg.image' }];

/** The chat background panel. Every change shows in the chat behind it straight away and is saved per chat on this device. */
export function BackgroundPicker({ bg, hasImage, error, onChange, onPick, onReset, onClose }: {
  bg: ChatBg; hasImage: boolean; error: boolean; onChange: (patch: Partial<ChatBg>) => void; onPick: (file: File) => void; onReset: () => void; onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null), file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', esc); return () => document.removeEventListener('keydown', esc);
  }, []);
  const setMode = (mode: BgMode) => {
    if (mode === 'image' && !hasImage) { file.current?.click(); return; }
    onChange({ mode, ...(mode === 'solid' && !bg.solid ? { solid: SOLIDS[0].id } : {}) });
  };
  const modeKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0; if (!d) return;
    e.preventDefault(); const next = MODES[(i + d + MODES.length) % MODES.length]; setMode(next.mode);
    queueMicrotask(() => panel.current?.querySelectorAll<HTMLElement>('[role=radio]')[(i + d + MODES.length) % MODES.length]?.focus());
  };
  return (
    <div class="bg-panel card" role="dialog" aria-label={t('chatbg.title')} ref={panel}>
      <div class="bg-head"><h2>{t('chatbg.title')}</h2><button type="button" class="icon-btn" aria-label={t('chatbg.close')} onClick={onClose}><Icon name="close" size={20} /></button></div>
      <div class="bg-modes" role="radiogroup" aria-label={t('chatbg.mode')}>
        {MODES.map((m, i) => <button type="button" key={m.mode} role="radio" aria-checked={bg.mode === m.mode} tabIndex={bg.mode === m.mode ? 0 : -1} class={`bg-mode${bg.mode === m.mode ? ' on' : ''}`} onClick={() => setMode(m.mode)} onKeyDown={(e) => modeKey(e, i)}>{t(m.label)}</button>)}
      </div>
      {(bg.mode === 'solid' || bg.mode === 'pattern') && (
        <div class="bg-section"><h3>{t('chatbg.colours')}</h3>
          <div class="bg-swatches" role="radiogroup" aria-label={t('chatbg.colours')}>
            {bg.mode === 'pattern' && <button type="button" role="radio" aria-checked={bg.solid === ''} aria-label={t('chatbg.default')} class={`bg-swatch plain${bg.solid === '' ? ' on' : ''}`} onClick={() => onChange({ solid: '' })} />}
            {SOLIDS.map((s) => <button type="button" key={s.id} role="radio" aria-checked={bg.solid === s.id} aria-label={s.name} title={s.name} class={`bg-swatch${bg.solid === s.id ? ' on' : ''}`} style={{ background: solidVar(s.id) }} onClick={() => onChange({ solid: s.id })} />)}
          </div>
        </div>
      )}
      {bg.mode === 'pattern' && (
        <div class="bg-section"><h3>{t('chatbg.patterns')}</h3>
          <div class="bg-swatches patterns" role="radiogroup" aria-label={t('chatbg.patterns')}>
            {PATTERNS.map((p) => <button type="button" key={p.id} role="radio" aria-checked={bg.pattern === p.id} aria-label={p.name} title={p.name} class={`bg-swatch pat${bg.pattern === p.id ? ' on' : ''}`} style={{ background: bg.solid ? solidVar(bg.solid) : 'var(--bg)' }} onClick={() => onChange({ pattern: p.id })}>
              <i style={{ WebkitMaskImage: patternUrl(p), maskImage: patternUrl(p), WebkitMaskSize: `${p.width}px ${p.height}px`, maskSize: `${p.width}px ${p.height}px`, '--pat-o': `var(--chat-pattern-${p.id}-opacity)` } as any} />
            </button>)}
          </div>
        </div>
      )}
      {bg.mode === 'image' && (
        <div class="bg-section">
          {!hasImage && <p class="muted small">{t('chatbg.noPicture')}</p>}
          <div class="bg-slider"><label for="bg-blur">{t('chatbg.blur')}</label><input id="bg-blur" type="range" min={0} max={LIMITS.blurMax} step={1} value={bg.blur} onInput={(e) => onChange({ blur: Number((e.currentTarget as HTMLInputElement).value) })} /><output for="bg-blur">{bg.blur}</output></div>
          <div class="bg-slider"><label for="bg-dim">{t('chatbg.dim')}</label><input id="bg-dim" type="range" min={0} max={Math.round(LIMITS.dimMax * 100)} step={1} value={Math.round(bg.dim * 100)} onInput={(e) => onChange({ dim: Number((e.currentTarget as HTMLInputElement).value) / 100 })} /><output for="bg-dim">{Math.round(bg.dim * 100)}%</output></div>
        </div>
      )}
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) onPick(f); }} />
      {error && <p class="error small" role="alert">{t('chatbg.failed')}</p>}
      <div class="bg-actions">
        <button type="button" class="btn outline inline" onClick={() => file.current?.click()}><Icon name="image" size={18} />{hasImage ? t('chatbg.change') : t('chatbg.choose')}</button>
        <button type="button" class="btn text" disabled={isDefault(bg) && !hasImage} onClick={onReset}><Icon name="reset" size={18} />{t('chatbg.reset')}</button>
      </div>
      <p class="muted small bg-note">{t('chatbg.local')}</p>
    </div>
  );
}
