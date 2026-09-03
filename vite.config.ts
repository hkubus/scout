import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
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
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
