import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30000,
    pool: 'forks',
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
