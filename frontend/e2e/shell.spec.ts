import { expect, test, type Page } from '@playwright/test';
import {
  closeMenu,
  company,
  conversation,
  goTo,
  installApi,
  menuItems,
  openMenu,
  SENTINEL,
  switchTo,
} from './company-fixture';

const isMobile = (name: string) => name === 'mobile';

async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const element = document.scrollingElement;
    return element !== null && element.scrollWidth <= element.clientWidth;
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`desktop: menu lateral fixo, sem cartão nem abas (tema ${theme})`, async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'menu fixo só no computador');
    await page.addInitScript((value) => localStorage.setItem('soprei-theme', value), theme);
    await page.setViewportSize({ width: 1280, height: 800 });
    await installApi(page);
    await page.goto('/painel/conversas');
    const nav = page.getByRole('navigation', { name: 'Menu da empresa' });
    await expect(nav).toBeVisible();
    await expect(page.getByRole('button', { name: 'Abrir menu' })).toBeHidden();
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Trocar de empresa/ })).toContainText(
      'Empresa A',
    );
    await expect(page.getByText('pessoa@example.test')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sair' })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Conversas');
    await expect(nav.getByRole('link', { name: 'Conversas' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await nav.getByRole('link', { name: 'Persona' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Persona');
    await expect(page).toHaveURL(/\/painel\/persona$/);
    await expect(nav.getByRole('link', { name: 'Persona' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(nav.getByRole('link', { name: 'Conversas' })).not.toHaveAttribute('aria-current');
  });
}

test('VIEWER: o menu mostra só as telas permitidas e a URL forçada não chama a API', async ({
  page,
}) => {
  const api = await installApi(page, { role: 'VIEWER' });
  await page.goto('/painel/canal');
  expect(await menuItems(page)).toEqual(['Conversas']);
  await expect(page.getByText('Você não tem permissão para ver esta tela.')).toBeVisible();
  expect(api.calls.filter((call) => call.path.includes('/channel'))).toHaveLength(0);
});

test('celular: abrir menu, foco, Esc, escolher tela e Tab preso no painel', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApi(page);
  await page.goto('/painel/conversas');
  await expect(page.getByRole('navigation', { name: 'Menu da empresa' })).toBeHidden();
  const open = page.getByRole('button', { name: 'Abrir menu' });
  await expect(open).toHaveAttribute('aria-expanded', 'false');
  await open.click();
  const nav = page.getByRole('navigation', { name: 'Menu da empresa' });
  await expect(nav).toBeVisible();
  // O foco vai para dentro da gaveta (no botão de fechar).
  await expect(page.getByRole('button', { name: 'Fechar menu' })).toBeFocused();
  // Tab nunca sai do painel.
  for (let index = 0; index < 20; index++) {
    await page.keyboard.press('Tab');
    // O foco fica no painel (ou sai para fora da página), nunca no conteúdo de trás.
    const behind = await page.evaluate(
      () => document.querySelector('main')?.contains(document.activeElement) ?? false,
    );
    expect(behind).toBe(false);
  }
  await page.keyboard.press('Escape');
  await expect(nav).toBeHidden();
  await expect(open).toBeFocused();
  // Escolher uma tela fecha o painel e abre a tela.
  await goTo(page, 'Persona');
  await expect(nav).toBeHidden();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Persona');
  // Fechar pelo botão.
  await openMenu(page);
  await closeMenu(page);
  await expect(nav).toBeHidden();
  await expect(open).toBeFocused();
});

test('sem rolagem horizontal da página em 360 e 390 px', async ({ page }) => {
  const api = await installApi(page);
  api.conversations = [conversation('Contato final 1234', 'whatsapp', 1)];
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of [
      '/painel/conversas',
      '/painel/testar',
      '/painel/canal',
      '/painel/persona',
    ]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await noHorizontalScroll(page), `${path} em ${String(width)} px`).toBe(true);
    }
  }
});

test('movimento reduzido: o painel do celular abre sem animação; sem a preferência, anima', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApi(page);
  // A gaveta do Dashboard Shell anima por transform (motion): logo depois do clique, sem a preferência ela
  // ainda está deslocada; com `prefers-reduced-motion` já abre no lugar, sem transição.
  const transformRightAfterOpen = () =>
    page.evaluate(async () => {
      const button = document.querySelector<HTMLElement>('button[aria-label="Abrir menu"]');
      button?.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const drawer = document.querySelector('[role="dialog"][aria-modal="true"]');
      return drawer === null ? null : getComputedStyle(drawer).transform;
    });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/painel/conversas');
  await expect(page.getByRole('button', { name: 'Abrir menu' })).toBeVisible();
  const reduced = await transformRightAfterOpen();
  expect(reduced === 'none' || reduced === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true);
  await closeMenu(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Abrir menu' })).toBeVisible();
  const animated = await transformRightAfterOpen();
  expect(animated !== null && animated !== 'none' && animated !== 'matrix(1, 0, 0, 1, 0, 0)').toBe(
    true,
  );
  await closeMenu(page);
});

test('seletor de empresa: teclado, troca com remontagem e dado da outra empresa não sobra', async ({
  page,
}) => {
  const first = company('Empresa A');
  const second = company('Empresa B', 'AGENT');
  const api = await installApi(page, { companies: [first, second], selected: first.companyId });
  api.conversations = [conversation('Contato final 1111', 'whatsapp', 1)];
  await page.goto('/painel/conversas');
  await expect(page.getByRole('link', { name: /Contato final 1111/ })).toBeVisible();
  await openMenu(page);
  const trigger = page.getByRole('button', { name: /Trocar de empresa/ });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: /Empresa A/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: /Empresa B/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  api.conversations = [conversation('Contato final 2222', 'whatsapp', 1)];
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: /Contato final 2222/ })).toBeVisible();
  await expect(page.getByText('Contato final 1111')).toHaveCount(0);
  expect(
    api.calls.some((call) => call.path === `/account/companies/${second.companyId}/select`),
  ).toBe(true);
  expect(api.selected).toBe(second.companyId);
  // Papel menor da empresa nova: o menu é o dela.
  expect(await menuItems(page)).toEqual(['Conversas', 'Testar']);
});

test('falha no select ao trocar de empresa mantém a empresa e a tela atuais', async ({ page }) => {
  const first = company('Empresa A');
  const second = company('Empresa B');
  const api = await installApi(page, { companies: [first, second], selected: first.companyId });
  await page.goto('/painel/persona');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Persona');
  api.selectStatus = 500;
  await switchTo(page, 'Empresa B');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(SENTINEL);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Persona');
  await expect(page).toHaveURL(/\/painel\/persona$/);
  expect(api.selected).toBe(first.companyId);
});

test('Gerenciar empresas abre a tela de empresas; Sair volta ao login e falha é informada', async ({
  page,
}) => {
  const api = await installApi(page);
  await page.goto('/painel/conversas');
  await openMenu(page);
  await page.getByRole('button', { name: /Trocar de empresa/ }).click();
  await page.getByRole('menuitem', { name: 'Gerenciar empresas' }).click();
  await expect(page.getByText('Suas empresas')).toBeVisible();
  await expect(page).toHaveURL(/\/painel\/empresas$/);

  await page.getByRole('button', { name: 'Abrir painel' }).click();
  await page.route('**/api/auth/logout', (route) =>
    route.fulfill({
      status: 500,
      json: { error: { code: 'X', message: SENTINEL, requestId: 'x' } },
    }),
  );
  await openMenu(page);
  await page.getByRole('button', { name: 'Sair', exact: true }).click();
  await expect(page.getByText('Saída não confirmada: você continua conectado')).toBeVisible();
  await page.unroute('**/api/auth/logout');
  await openMenu(page);
  await page.getByRole('button', { name: 'Sair', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Entrar' })).toBeVisible();
  expect(api.calls.filter((call) => call.path === '/auth/logout').length).toBeGreaterThan(0);
});

test('voltar e avançar do navegador dentro do painel', async ({ page }) => {
  const api = await installApi(page);
  const target = conversation('Contato final 1234', 'whatsapp', 1);
  api.conversations = [target];
  api.history = { [target.id]: [] };
  await page.goto('/painel/conversas');
  await page.getByRole('link', { name: /Contato final 1234/ }).click();
  await expect(page).toHaveURL(new RegExp(`/painel/conversas/${target.id}$`));
  await page.goBack();
  await expect(page).toHaveURL(/\/painel\/conversas$/);
  await expect(page.getByRole('link', { name: /Contato final 1234/ })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/painel/conversas/${target.id}$`));
});

test('o menu não grava nada no armazenamento além do tema', async ({ page }) => {
  await installApi(page);
  await page.goto('/painel/conversas');
  await openMenu(page);
  await closeMenu(page);
  const keys = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
  }));
  expect(keys.local.filter((key) => key !== 'soprei-theme')).toEqual([]);
  expect(keys.session).toEqual([]);
});
