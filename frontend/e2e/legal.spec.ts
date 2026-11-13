import { expect, test, type Page, type Request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { installApi } from './company-fixture';

// Spec 032 (E1): páginas públicas de privacidade, termos e exclusão de dados. O texto está no HTML (estático no
// build; no desenvolvimento o plugin do vite.config.ts serve a mesma página), legível sem JavaScript.
const source = (file: string) =>
  readFileSync(new URL(`../src/legal/${file}`, import.meta.url), 'utf8');
const isVigente = (file: string) => /^situacao: vigente$/m.test(source(file));
// Data e versão vêm do cabeçalho de cada texto (a política passou à versão 2 na spec 040, E3).
const headerOf = (file: string) => {
  const date = /^atualizado-em: (\d{4})-(\d{2})-(\d{2})$/m.exec(source(file));
  const version = /^versao: (\d+)$/m.exec(source(file));
  return {
    updated: `Última atualização: ${date?.[3] ?? ''}/${date?.[2] ?? ''}/${date?.[1] ?? ''}`,
    version: `Versão ${version?.[1] ?? ''}`,
  };
};
// `vigente` vem do próprio texto: rascunho mostra a faixa e os marcadores; vigente não tem nenhum dos dois.
const PAGES = [
  {
    path: '/privacidade',
    title: 'Política de Privacidade do Soprei',
    vigente: isVigente('privacidade.md'),
    ...headerOf('privacidade.md'),
  },
  {
    path: '/termos',
    title: 'Termos de Uso do Soprei',
    vigente: isVigente('termos.md'),
    ...headerOf('termos.md'),
  },
  {
    path: '/exclusao-de-dados',
    title: 'Como pedir a exclusão dos seus dados',
    vigente: isVigente('exclusao-de-dados.md'),
    ...headerOf('exclusao-de-dados.md'),
  },
] as const;
const DRAFT = 'Texto preliminar, em revisão. Pode mudar.';
const isMobile = (name: string) => name === 'mobile';
// D2: os termos só são publicados (link e termos.html) quando `vigente`; o servidor de desenvolvimento serve
// /termos de qualquer jeito, para revisão.
const TERMS_VIGENTE = isVigente('termos.md');
const LINKS_LABEL = TERMS_VIGENTE ? 'Privacidade e termos' : 'Privacidade';

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

for (const { path, title, vigente, updated, version } of PAGES) {
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
      expect(html).toContain(updated);
      expect(html).toContain(version);
      if (vigente) expect(html).not.toContain(DRAFT);
      else expect(html).toContain(DRAFT);
      expect(html.match(/<script/g)?.length).toBe(1);
      expect(html).not.toContain('type="module"');
      expect(html).not.toContain('id="root"');
      expect(html).not.toMatch(/googleapis|gstatic|connect\.facebook/);
      if (!TERMS_VIGENTE && path !== '/termos') expect(html).not.toContain('href="/termos"');
    }
  });
}

test.describe('sem JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  for (const { path, title, vigente, updated } of PAGES) {
    test(`${path}: título, data e faixa de rascunho (só em rascunho) visíveis`, async ({
      page,
    }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await expect(page.getByText(updated)).toBeVisible();
      await expect(page.getByText(DRAFT)).toHaveCount(vigente ? 0 : 1);
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
      for (const { path, title, vigente } of PAGES) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
        // Texto vigente nunca tem marcador pendente (o build também recusa).
        if (vigente) await expect(page.locator('mark.legal-marker')).toHaveCount(0);
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
  const footer = page.getByRole('contentinfo').getByRole('navigation', { name: LINKS_LABEL });
  for (const [name, href] of [
    ['Política de Privacidade', '/privacidade'],
    ['Exclusão de dados', '/exclusao-de-dados'],
  ] as const)
    await expect(footer.getByRole('link', { name })).toHaveAttribute('href', href);
  // D2: "Termos de Uso" só aparece com os termos vigentes.
  await expect(footer.getByRole('link', { name: 'Termos de Uso' })).toHaveCount(
    TERMS_VIGENTE ? 1 : 0,
  );
  for (const path of ['/entrar', '/criar-conta', '/recuperar-senha', '/convite']) {
    await page.goto(path);
    const nav = page.getByRole('navigation', { name: LINKS_LABEL });
    await expect(nav.getByRole('link', { name: 'Política de Privacidade' })).toHaveAttribute(
      'href',
      '/privacidade',
    );
    await expect(nav.getByRole('link', { name: 'Termos de Uso' })).toHaveCount(
      TERMS_VIGENTE ? 1 : 0,
    );
  }
  await page
    .getByRole('navigation', { name: LINKS_LABEL })
    .getByRole('link', { name: 'Política de Privacidade' })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Política de Privacidade do Soprei' }),
  ).toBeVisible();
  expect(forbidden(requests).filter((url) => !url.includes('/api/'))).toEqual([]);
});

test('menu do painel tem o link para a política', async ({ page }, testInfo) => {
  test.skip(isMobile(testInfo.project.name), 'menu fixo só no computador');
  await page.setViewportSize({ width: 1280, height: 800 });
  await installApi(page);
  await page.goto('/painel/conversas');
  await expect(page.getByRole('link', { name: LINKS_LABEL, exact: true })).toHaveAttribute(
    'href',
    '/privacidade',
  );
});
