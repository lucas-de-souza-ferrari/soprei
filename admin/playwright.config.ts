import { defineConfig, devices } from '@playwright/test';

/**
 * Spec 044, E3: API falsa por `page.route` em cada teste (sem backend). Desktop e celular de 360 px, cada
 * um no tema claro e no escuro (o admin segue só o `prefers-color-scheme`).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  workers: process.env.CI ? 1 : undefined,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:5187',
    trace: 'retain-on-failure',
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
  },
  projects: [
    { name: 'desktop-claro', use: { ...devices['Desktop Chrome'], colorScheme: 'light' } },
    { name: 'desktop-escuro', use: { ...devices['Desktop Chrome'], colorScheme: 'dark' } },
    {
      name: 'celular-claro',
      use: { viewport: { width: 360, height: 780 }, colorScheme: 'light', reducedMotion: 'reduce' },
    },
    {
      name: 'celular-escuro',
      use: { viewport: { width: 360, height: 780 }, colorScheme: 'dark', reducedMotion: 'reduce' },
    },
  ],
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5187 --strictPort',
    url: 'http://127.0.0.1:5187',
    reuseExistingServer: false,
  },
});
