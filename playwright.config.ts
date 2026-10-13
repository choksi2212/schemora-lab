import { defineConfig, devices } from '@playwright/test';
const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3010';

export default defineConfig({
  testDir: './apps/web/e2e',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: origin, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: origin,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: {
      DEV_AUTH: 'true',
      WEB_ORIGIN: origin,
      NODE_ENV: 'development',
      CI: '1',
      SCHEMORA_WATCH: 'false',
    },
  },
});
