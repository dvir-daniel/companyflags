import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The API (`node --watch server/index.ts` in `pnpm dev`): 8787, or the PORT it was started with, e.g. `PORT=8797 pnpm dev`
// when something else already listens on 8787.
const api = `http://localhost:${process.env.PORT || 8787}`;
// The console's UI library (tokens, Tailwind theme, shadcn components): packages/ui, a workspace package.
const ui = path.resolve(import.meta.dirname, 'packages/ui');

const { version } = JSON.parse(readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf8')) as { version: string };

export default defineConfig({
  root: 'web',
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react(), tailwindcss()],
  resolve: {
    // the library's imports use this app's copies, so there is one React
    dedupe: ['react', 'react-dom', '@base-ui/react', '@phosphor-icons/react', 'cmdk', 'class-variance-authority', 'cn'],
  },
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': api, '/sdk': api, '/client': api },
    fs: { allow: [import.meta.dirname, ui] },
  },
});
