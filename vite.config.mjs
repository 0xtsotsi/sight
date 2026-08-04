import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
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
