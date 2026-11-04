import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const envPath = fileURLToPath(new URL('.env', import.meta.url));
if (existsSync(envPath)) loadEnvFile(envPath);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/api/tests/**/*.integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
