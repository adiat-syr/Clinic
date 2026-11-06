import { defineConfig } from '@playwright/test';
if (!process.env.WEB_HTTPS_BASE?.startsWith('https://clinic.localhost:'))
  throw new Error('Local HTTPS runner required');
export default defineConfig({
  testDir: './tests/https',
  workers: 1,
  timeout: 45000,
  reporter: 'list',
  use: {
    baseURL: process.env.WEB_HTTPS_BASE,
    ignoreHTTPSErrors: true,
    trace: 'off',
    screenshot: 'off',
  },
});
