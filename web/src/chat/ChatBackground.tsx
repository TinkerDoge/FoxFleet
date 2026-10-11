import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_BG, LIMITS, PATTERNS, SOLIDS, downscaleBackground, images, isDefault, loadBg, moveBg, normalizeBg, patternUrl, resetBg, saveBg, solidVar, type ChatBg } from '../lib/chatBg';

/** The look of one chat: settings from localStorage, the picture from IndexedDB (as an object URL). All on this device. */
export function useChatBg(key: string, previousKey?: string) {
  const [bg, setBg] = useState<ChatBg>(() => loadBg(key)), [url, setUrl] = useState<string>(), [error, setError] = useState(false);
  const alive = useRef(0);
  useEffect(() => {
    const run = ++alive.current; let made: string | undefined;
    (async () => {
      if (previousKey && previousKey !== key) await moveBg(previousKey, key);
      const next = loadBg(key); if (run !== alive.current) return; setBg(next); setUrl(undefined); setError(false);
      if (!next.image) return;
      const blob = await images().get(key).catch(() => undefined);
      if (run !== alive.current) return;
      if (blob) { made = URL.createObjectURL(blob); setUrl(made); } else setBg((b) => normalizeBg({ ...b, image: false }));
    })();
    return () => { if (made) URL.revokeObjectURL(made); };
  }, [key]);
  const update = useCallback((patch: Partial<ChatBg>) => setBg((b) => { const next = normalizeBg({ ...b, ...patch }); saveBg(key, next); return next; }), [key]);
  const pick = useCallback(async (file: File) => {
    setError(false); const run = alive.current;
    try {
      const blob = await downscaleBackground(file); await images().put(key, blob); if (run !== alive.current) return;
      setUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
      setBg((b) => { const next = normalizeBg({ ...b, image: true, mode: 'image' }); saveBg(key, next); return next; });
    } catch { setError(true); }
  }, [key]);
  const reset = useCallback(async () => { alive.current++; setUrl((old) => { if (old) URL.revokeObjectURL(old); return undefined; }); setBg(await resetBg(key)); setError(false); }, [key]);
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
