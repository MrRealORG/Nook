import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  base: './',
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    target: 'chrome105',
    outDir: 'dist',
    emptyOutDir: true
  }
});
