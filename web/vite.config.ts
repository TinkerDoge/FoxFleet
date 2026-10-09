/// <reference types="vitest" />
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Dev: `npm run dev` proxies /api, /connector.mjs and the WebSocket paths to a hub on 127.0.0.1:3080 (override with FOXFLEET_DEV_HUB).
const hub = process.env.FOXFLEET_DEV_HUB || 'http://127.0.0.1:3080';
export default defineConfig({
  plugins: [preact()],
  build: { target: 'es2022', sourcemap: false, assetsDir: 'assets' },
  server: { proxy: { '/api': { target: hub, ws: true }, '/health': hub, '/connector.mjs': hub, '/connect-agent.md': hub } },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts?(x)'] },
});
