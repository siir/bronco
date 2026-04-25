import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60000,
    // Run integration tests sequentially to avoid DB / FS contention
    pool: 'forks',
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
