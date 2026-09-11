import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

// No `define` of env secrets here: anything inlined this way ships in the
// public client bundle. The AI Studio template's GEMINI_API_KEY define was
// unused by src/ and would have published a key the day a .env appeared.
export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          pixelGrid: path.resolve(__dirname, 'pixel-grid.html'),
        },
      },
    },
    server: {
      // Honor a harness-assigned port (PORT env var); fall back to 3000 for
      // manual `npm run dev`, and let the preview auto-pick a free port when
      // 3000 is taken by another session's server.
      port: process.env.PORT ? Number(process.env.PORT) : 3000,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
