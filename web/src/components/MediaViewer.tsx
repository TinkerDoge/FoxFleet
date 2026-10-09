import { useEffect, useRef, useState } from 'preact/hooks';

export interface MediaItem { kind: 'image' | 'video'; src: string; alt?: string }

/** Fullscreen viewer: images zoom with wheel / pinch / double-click and pan by dragging; videos use the native player. */
export function MediaViewer({ item, onClose }: { item: MediaItem; onClose: () => void }) {
  const [scale, setScale] = useState(1), [pos, setPos] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>()), pinch = useRef(0), drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const reset = () => { setScale(1); setPos({ x: 0, y: 0 }); };
  const clamp = (s: number) => Math.min(8, Math.max(1, s));
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); if (e.key === '+' || e.key === '=') setScale((s) => clamp(s * 1.25)); if (e.key === '-') setScale((s) => clamp(s / 1.25)); if (e.key === '0') reset(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
  useEffect(() => { const prev = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = prev; }; }, []);
  const dist = () => { const [a, b] = [...pointers.current.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  return (
    <div class="viewer" role="dialog" aria-modal="true" aria-label={item.alt || (item.kind === 'video' ? 'Video' : 'Image')} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="viewer-bar">
        {item.kind === 'image' && <><button class="icon-btn" aria-label="Zoom out" onClick={() => setScale((s) => clamp(s / 1.25))}>−</button><button class="icon-btn" aria-label="Zoom in" onClick={() => setScale((s) => clamp(s * 1.25))}>+</button><button class="icon-btn" aria-label="Reset zoom" onClick={reset}>1:1</button></>}
        <button class="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      {item.kind === 'video'
        ? <video class="viewer-media" src={item.src} controls autoplay playsInline />
        : <img class="viewer-media" src={item.src} alt={item.alt ?? ''} draggable={false}
            style={{ transform: `translate(${pos.x}px,${pos.y}px) scale(${scale})`, cursor: scale > 1 ? 'grab' : 'zoom-in', touchAction: 'none' }}
            onDblClick={() => (scale > 1 ? reset() : setScale(2.5))}
            onWheel={(e) => { e.preventDefault(); setScale((s) => clamp(s * (e.deltaY < 0 ? 1.12 : 1 / 1.12))); }}
            onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pointers.current.size === 2) pinch.current = dist(); else drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }; }}
            onPointerMove={(e) => {
              if (!pointers.current.has(e.pointerId)) return; pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
              if (pointers.current.size === 2 && pinch.current) { const d = dist(); setScale((s) => clamp(s * d / pinch.current)); pinch.current = d; }
              else if (drag.current && scale > 1) setPos({ x: drag.current.px + e.clientX - drag.current.x, y: drag.current.py + e.clientY - drag.current.y });
            }}
            onPointerUp={(e) => { pointers.current.delete(e.pointerId); pinch.current = 0; drag.current = null; if (scale <= 1) setPos({ x: 0, y: 0 }); }}
            onPointerCancel={(e) => { pointers.current.delete(e.pointerId); pinch.current = 0; drag.current = null; }} />}
    </div>
  );
}
