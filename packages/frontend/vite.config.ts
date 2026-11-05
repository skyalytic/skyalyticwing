/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // 阈值设为略低于当前实际水平的目标档位（防止覆盖率回退）
      thresholds: {
        statements: 15,
        branches: 60,
        functions: 40,
        lines: 15,
      },
    },
  },
  server: {
    port: 1421,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:19111',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:19111',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'markdown-vendor': ['react-markdown', 'rehype-sanitize', 'rehype-highlight'],
        },
      },
    },
  },
});
