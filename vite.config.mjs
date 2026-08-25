import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    // Allow ngrok-fronted connections for AFK visual feedback (issue #2026-08-06-afk-router).
    // Without this Vite returns 403 "Blocked request. This host is not allowed."
    // when the Origin/Host header comes from ngrok's reverse-proxy domain.
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      '.ngrok-free.dev',
      '.ngrok.app',
    ],
  },
  optimizeDeps: {
    // Pre-bundle @fal-ai/client so the renderer doesn't fail to resolve it
    // when first hit. The package is dynamically imported from media.js and
    // should never appear in the browser bundle unless selectProviderAsync()
    // routes a call through FalProvider (Node-only code path).
    include: ['@fal-ai/client'],
  },
  build: {
    outDir: 'dist',
  },
  define: {
    // The @kenkaiiii/gg-agent package references `process.env` at module
    // top-level. Replace it with a browser-safe literal so the renderer
    // doesn't crash on load. The agent never reads from `process` at
    // runtime in the renderer (it's declared in src/agent/systemPrompt.js
    // as a Node-only path), so this is a no-op at runtime.
    'process.env': '{}',
    'process.platform': '"browser"',
    'process.version': '"0"',
  },
});
