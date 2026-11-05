import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/logger/index.ts',
    'src/errors/index.ts',
    'src/utils/index.ts',
    'src/types/index.ts',
    'src/constants/index.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
});
