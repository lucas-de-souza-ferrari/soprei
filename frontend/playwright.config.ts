import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:5186',
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' } },
  ],
  webServer: {
    command: 'pnpm dev --port 5186 --strictPort',
    url: 'http://127.0.0.1:5186',
    reuseExistingServer: false,
  },
});
