import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/web',
  workers: 1,
  timeout: 30000,
  use: { baseURL: process.env.WEB_TEST_BASE, trace: 'off', screenshot: 'off' },
  reporter: 'list',
});
