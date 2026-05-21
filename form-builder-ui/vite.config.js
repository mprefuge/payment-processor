import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: '../dist/services/formBuilder/builder-dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7075',
    },
  },
});
