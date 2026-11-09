import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: true,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.SHOPGUARD_PREVIEW_URL,
    trace: 'retain-on-failure',
  },
});
