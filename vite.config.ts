import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [react()],
  server: {
    port: 4173,
    proxy: {
      '/api': process.env.SCOUT_API_PROXY ?? 'http://127.0.0.1:3001',
      '/events': process.env.SCOUT_API_PROXY ?? 'http://127.0.0.1:3001',
    },
  },
  preview: {
    port: 4173,
  },
  // The server build (npm run build:server) gives its chunks stable names: a
  // running server lazily imports ./mcp.js on the first /mcp request, and an
  // in-place rebuild that fails before the restart must not leave it pointing
  // at a deleted content-hashed file.
  build: isSsrBuild
    ? { rollupOptions: { output: { chunkFileNames: '[name].js' } } }
    : { outDir: 'dist', emptyOutDir: true },
}));
