import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  define: { __GLEEOK_BUILD__: JSON.stringify(new Date().toISOString()) },
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
});
