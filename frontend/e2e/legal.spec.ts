import { expect, test, type Page, type Request } from '@playwright/test';
import { installApi } from './company-fixture';

// Spec 032 (E1): páginas públicas de privacidade, termos e exclusão de dados. O texto está no HTML (estático no
// build; no desenvolvimento o plugin do vite.config.ts serve a mesma página), legível sem JavaScript.
const PAGES = [
  { path: '/privacidade', title: 'Política de Privacidade do Soprei' },
  { path: '/termos', title: 'Termos de Uso do Soprei' },
  { path: '/exclusao-de-dados', title: 'Como pedir a exclusão dos seus dados' },
] as const;
const UPDATED = 'Última atualização: 12/11/2026';
const DRAFT = 'Texto preliminar, em revisão. Pode mudar.';
const isMobile = (name: string) => name === 'mobile';

function watchRequests(page: Page): Request[] {
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  return requests;
}

function forbidden(requests: readonly Request[]): string[] {
  return requests
    .map((request) => new URL(request.url()))
    .filter(
      (url) =>
        url.pathname.startsWith('/api/') ||
        url.hostname === 'fonts.googleapis.com' ||
        url.hostname === 'fonts.gstatic.com' ||
        url.hostname.endsWith('facebook.net') ||
        url.hostname.endsWith('facebook.com'),
    )
    .map((url) => url.origin + url.pathname);
}

for (const { path, title } of PAGES) {
  test(`${path}: o HTML cru já tem o texto, a data, a versão e só o script de tema`, async ({
    request,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'mesmo HTML nos dois projetos');
    for (const url of [path, `${path}.html`]) {
      const response = await request.get(url);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('text/html');
      const html = await response.text();
      expect(html).toContain(`<h1>${title}</h1>`);
      expect(html).toContain(UPDATED);
      expect(html).toContain('Versão 1');
      expect(html).toContain(DRAFT);
      expect(html.match(/<script/g)?.length).toBe(1);
      expect(html).not.toContain('type="module"');
      expect(html).not.toContain('id="root"');
      expect(html).not.toMatch(/googleapis|gstatic|connect\.facebook/);
    }
  });
}

test.describe('sem JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  for (const { path, title } of PAGES) {
    test(`${path}: título, data e faixa de rascunho visíveis`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await expect(page.getByText(UPDATED)).toBeVisible();
      await expect(page.getByText(DRAFT)).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Documentos legais' })).toBeVisible();
    });
  }
});

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [360, 1280]) {
    test(`páginas legais a ${width} px, tema ${scheme}: sem rolagem horizontal, sem API e sem gravar nada`, async ({
      page,
    }, testInfo) => {
      test.skip(isMobile(testInfo.project.name), 'larguras definidas no próprio teste');
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      const requests = watchRequests(page);
      for (const { path, title } of PAGES) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
        // Marcadores do rascunho aparecem destacados.
        await expect(page.locator('mark.legal-marker').first()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
          scheme === 'dark',
        );
        expect(
          await page.evaluate(() => {
            const element = document.scrollingElement;
            return element !== null && element.scrollWidth <= element.clientWidth;
          }),
        ).toBe(true);
        expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
        expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
      }
      expect(forbidden(requests)).toEqual([]);
      expect(requests.some((request) => request.url().includes('/fonts/'))).toBe(true);
    });
  }
}

test('o tema escolhido no site vale nas páginas legais (só leitura de soprei-theme)', async ({
  page,
}, testInfo) => {
  test.skip(isMobile(testInfo.project.name), 'um projeto basta');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => localStorage.setItem('soprei-theme', 'dark'));
  await page.goto('/termos');
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(['soprei-theme']);
});

test('links: rodapé da página inicial e telas de conta, sem fontes do Google', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 401, json: {} }));
  const requests = watchRequests(page);
  await page.goto('/');
  const footer = page.getByRole('contentinfo').getByRole('navigation', {
    name: 'Privacidade e termos',
  });
  for (const [name, href] of [
    ['Política de Privacidade', '/privacidade'],
    ['Termos de Uso', '/termos'],
    ['Exclusão de dados', '/exclusao-de-dados'],
  ] as const)
    await expect(footer.getByRole('link', { name })).toHaveAttribute('href', href);
  for (const path of ['/entrar', '/criar-conta', '/recuperar-senha', '/convite']) {
    await page.goto(path);
    const nav = page.getByRole('navigation', { name: 'Privacidade e termos' });
    await expect(nav.getByRole('link', { name: 'Política de Privacidade' })).toHaveAttribute(
      'href',
      '/privacidade',
    );
    await expect(nav.getByRole('link', { name: 'Termos de Uso' })).toHaveAttribute(
      'href',
      '/termos',
    );
  }
  await page
    .getByRole('navigation', { name: 'Privacidade e termos' })
    .getByRole('link', {
      name: 'Termos de Uso',
    })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Termos de Uso do Soprei' }),
  ).toBeVisible();
  expect(forbidden(requests).filter((url) => !url.includes('/api/'))).toEqual([]);
});

test('menu do painel tem "Privacidade e termos"', async ({ page }, testInfo) => {
  test.skip(isMobile(testInfo.project.name), 'menu fixo só no computador');
  await page.setViewportSize({ width: 1280, height: 800 });
  await installApi(page);
  await page.goto('/painel/conversas');
  await expect(page.getByRole('link', { name: 'Privacidade e termos' })).toHaveAttribute(
    'href',
    '/privacidade',
  );
});
