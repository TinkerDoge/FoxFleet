/* Foxfleet service worker: caches the app shell only.
 * - Never touches /api, /health, /mcp, /connector.mjs or anything non-GET / cross-origin: those always go to the network.
 * - Versioned: the build stamps the version and file list below; a new version waits until the user taps "Reload" (no silent swap).
 * - Offline: navigations fall back to the cached shell, which then explains it can't reach the hub. */
const VERSION = '__VERSION__';
const SHELL = __SHELL__;
const CACHE = 'foxfleet-shell-' + VERSION;
const NEVER = /^\/(api|health|mcp|connector\.mjs|connect-agent\.md|pair|avatars)(\/|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('foxfleet-shell-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('message', (event) => { if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', (event) => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || NEVER.test(url.pathname) || req.headers.has('range')) return; // network, untouched
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/index.html')));
    return;
  }
  if (/^\/assets\//.test(url.pathname) || SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })));
  }
});
