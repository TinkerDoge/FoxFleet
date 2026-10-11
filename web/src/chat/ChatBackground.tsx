import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_BG, LIMITS, PATTERNS, SOLIDS, downscaleBackground, images, isDefault, loadBg, moveBg, normalizeBg, patternUrl, resetBg, saveBg, solidVar, type ChatBg } from '../lib/chatBg';

/** The look of one chat: settings from localStorage, the picture from IndexedDB (as an object URL). All on this device. */
export function useChatBg(key: string, previousKey?: string) {
  const [bg, setBg] = useState<ChatBg>(() => loadBg(key)), [url, setUrl] = useState<string>(), [error, setError] = useState(false);
  const alive = useRef(0), obj = useRef<string>();
  /** The one live object URL: every replacement, key change and unmount revokes the previous one, so no picture leaks. */
  const show = useCallback((blob?: Blob) => { if (obj.current) URL.revokeObjectURL(obj.current); obj.current = blob ? URL.createObjectURL(blob) : undefined; setUrl(obj.current); }, []);
  useEffect(() => () => { alive.current++; if (obj.current) URL.revokeObjectURL(obj.current); obj.current = undefined; }, []);
  useEffect(() => {
    const run = ++alive.current;
    (async () => {
      if (previousKey && previousKey !== key) await moveBg(previousKey, key);
      const next = loadBg(key); if (run !== alive.current) return; setBg(next); show(undefined); setError(false);
      if (!next.image) return;
      const blob = await images().get(key).catch(() => undefined);
      if (run !== alive.current) return;
      if (blob) show(blob); else setBg((b) => normalizeBg({ ...b, image: false }));
    })();
  }, [key]);
  const update = useCallback((patch: Partial<ChatBg>) => setBg((b) => { const next = normalizeBg({ ...b, ...patch }); saveBg(key, next); return next; }), [key]);
  const pick = useCallback(async (file: File) => {
    setError(false); const run = alive.current;
    try {
      const blob = await downscaleBackground(file); await images().put(key, blob); if (run !== alive.current) return;
      show(blob);
      setBg((b) => { const next = normalizeBg({ ...b, image: true, mode: 'image' }); saveBg(key, next); return next; });
    } catch { setError(true); }
  }, [key, show]);
  const reset = useCallback(async () => { alive.current++; show(undefined); setBg(await resetBg(key)); setError(false); }, [key, show]);
  return { bg, url: bg.mode === 'image' ? url : undefined, imageUrl: url, error, update, pick, reset };
}

/** Behind the messages. Decorative; theme colours and pattern ink come from the design tokens. */
export function ChatBackground({ bg, url }: { bg: ChatBg; url?: string }) {
  if (isDefault(bg)) return null;
  const pattern = bg.mode === 'pattern' ? PATTERNS.find((p) => p.id === bg.pattern) : undefined;
  return (
    <div class="chat-bg" data-mode={bg.mode} aria-hidden="true">
      {(bg.mode === 'solid' || bg.mode === 'pattern') && bg.solid && <div class="chat-bg-fill" style={{ background: solidVar(bg.solid) }} />}
      {pattern && <div class="chat-bg-pattern" style={{ WebkitMaskImage: patternUrl(pattern), maskImage: patternUrl(pattern), WebkitMaskSize: `${pattern.width}px ${pattern.height}px`, maskSize: `${pattern.width}px ${pattern.height}px`, '--pat-o': `var(--chat-pattern-${pattern.id}-opacity)` } as any} />}
      {bg.mode === 'image' && url && <>
        <div class="chat-bg-img" style={{ backgroundImage: `url("${url}")`, filter: `blur(${bg.blur}px)`, transform: bg.blur ? `scale(${1 + bg.blur / 160})` : undefined }} />
        <div class="chat-bg-dim" style={{ opacity: bg.dim }} />
      </>}
    </div>
  );
}
export { DEFAULT_BG, LIMITS, SOLIDS };
