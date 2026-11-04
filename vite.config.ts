import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    minify: 'esbuild',
  },
  optimizeDeps: {
    include: ['@mediapipe/tasks-vision'],
  },
});
