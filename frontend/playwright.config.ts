import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Spec 036: os testes não compartilham estado (API falsa por `page.route`, criada em cada teste),
  // então podem rodar em qualquer ordem. Com `fullyParallel` a divisão em fatias (`--shard`) do CI é
  // por teste e fica equilibrada. No CI, 1 worker por máquina (recomendação do Playwright); o paralelismo
  // vem das fatias, cada uma num job.
  fullyParallel: true,
  workers: process.env.CI ? 1 : undefined,
  // No CI uma retentativa: um teste que só passa na segunda tentativa aparece como "flaky" no
  // relatório (não some), e o rastreamento da tentativa que falhou fica guardado em test-results.
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:5186',
    trace: 'retain-on-failure',
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
