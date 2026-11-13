import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Dev runs through `tsx server/index.ts` with Vite in middleware mode,
// so this config mainly drives the production `vite build`.
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // Bot runtimes live inside the project but must never trigger page reloads:
    // setup/rebuilds write thousands of files here while the game is being played.
    watch: {
      ignored: ['**/.guandan/**', '**/.douzero/**', '**/.ai/**', '**/.board-ai/**', '**/.tmp-linux-export/**', '**/.tmp-ai-backup/**'],
    },
  },
});
