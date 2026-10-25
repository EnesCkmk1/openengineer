import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@openengineer/shared': path.resolve('packages/shared/src/index.ts'),
      '@openengineer/core': path.resolve('packages/core/src/index.ts'),
      '@openengineer/db': path.resolve('packages/db/src/index.ts'),
      '@openengineer/api': path.resolve('packages/api/src/server.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
