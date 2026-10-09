/** Registers the service worker (production, secure contexts only) and reports when a new version is waiting. */
export function registerSw(onUpdate: (apply: () => void) => void) {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD || !(isSecureContext || location.hostname === 'localhost')) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading && sessionStorage.getItem('foxfleet.updating')) { reloading = true; sessionStorage.removeItem('foxfleet.updating'); location.reload(); } });
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
    const offer = (w: ServiceWorker) => onUpdate(() => { sessionStorage.setItem('foxfleet.updating', '1'); w.postMessage({ type: 'SKIP_WAITING' }); });
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => { const w = reg.installing; w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); }); });
    setInterval(() => void reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch(() => { /* no worker: the app works the same, just without the offline shell */ });
}
