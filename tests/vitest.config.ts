import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@skyalyticwing/shared': resolve(__dirname, '../packages/shared/src'),
      '@skyalyticwing/core': resolve(__dirname, '../packages/core/src'),
      '@skyalyticwing/core/*': resolve(__dirname, '../packages/core/src/*'),
      '@skyalyticwing/cli': resolve(__dirname, '../packages/cli/src'),
      '@skyalyticwing/sdk': resolve(__dirname, '../packages/sdk/src'),
      '@skyalyticwing/channels': resolve(__dirname, '../packages/channels/src'),
      '@skyalyticwing/tools': resolve(__dirname, '../packages/tools/src'),
      '@skyalyticwing/providers': resolve(__dirname, '../packages/providers/src'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules', 'dist', '**/*.test.ts'],
    },
  },
});
