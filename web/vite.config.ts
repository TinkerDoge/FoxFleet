/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import preact from '@preact/preset-vite';

// Dev: `npm run dev` proxies /api, /connector.mjs and the WebSocket paths to a hub on 127.0.0.1:3080 (override with FOXFLEET_DEV_HUB).
const hub = process.env.FOXFLEET_DEV_HUB || 'http://127.0.0.1:3080';
/** Stamps public/sw.js with the build's file list and a content-derived version so every deploy is a new, prompted update. */
function serviceWorker(): Plugin {
  return {
    name: 'foxfleet-sw', apply: 'build',
    writeBundle(opts, bundle) {
      const dir = opts.dir ?? 'dist', files = ['/', '/index.html', '/manifest.webmanifest', '/favicon.png', '/icon-192.png', '/icon-512.png', ...Object.keys(bundle).filter((f) => f.startsWith('assets/')).map((f) => '/' + f)];
      const version = createHash('sha256').update(Object.keys(bundle).sort().join()).digest('hex').slice(0, 10);
      const src = readFileSync(resolve(dir, 'sw.js'), 'utf8').replace('__VERSION__', version).replace('__SHELL__', JSON.stringify(files));
      writeFileSync(resolve(dir, 'sw.js'), src);
    },
  };
}
export default defineConfig({
  plugins: [preact(), serviceWorker()],
  build: { target: 'es2022', sourcemap: false, assetsDir: 'assets' },
  server: { proxy: { '/api': { target: hub, ws: true }, '/health': hub, '/connector.mjs': hub, '/connect-agent.md': hub } },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts?(x)'] },
});
