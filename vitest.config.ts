import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/api/tests/**/*.test.ts', 'apps/web/src/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts'],
    testTimeout: 5_000,
  },
});
