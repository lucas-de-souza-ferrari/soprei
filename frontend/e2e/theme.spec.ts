import { test, expect, type Page } from '@playwright/test';

async function blockApi(page: Page) {
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/api/**', (route) => route.fulfill({ status: 401, json: {} }));
}
const isDark = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains('dark'));
const toggle = (page: Page) => page.getByRole('button', { name: /^Tema: / });

test('tema salvo escuro: o <html> já é dark antes de a aplicação carregar (sem piscar)', async ({
  page,
}) => {
  await blockApi(page);
  // Sem o módulo da aplicação, só o script do <head> pode ter aplicado a classe.
  await page.route('**/src/main.tsx', (route) => route.abort());
  await page.addInitScript(() => localStorage.setItem('soprei-theme', 'dark'));
  await page.goto('/', { waitUntil: 'commit' });
  await page.waitForLoadState('domcontentloaded');
  expect(await isDark(page)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark');
  expect(await page.locator('#root').innerHTML()).toBe('');
});

test('sem escolha salva, o tema acompanha o sistema, inclusive quando ele muda', async ({
  page,
}) => {
  await blockApi(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(toggle(page)).toHaveAttribute('aria-label', /Tema: Sistema/);
  expect(await isDark(page)).toBe(true);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => isDark(page)).toBe(false);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => isDark(page)).toBe(true);
});

test('valor inválido salvo é ignorado e vale o sistema', async ({ page }) => {
  await blockApi(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => localStorage.setItem('soprei-theme', 'roxo'));
  await page.goto('/');
  await expect(toggle(page)).toHaveAttribute('aria-label', /Tema: Sistema/);
  expect(await isDark(page)).toBe(false);
});

test('o controle muda o tema só pelo teclado, persiste ao recarregar e volta ao sistema', async ({
  page,
}) => {
  await blockApi(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await toggle(page).focus();
  await page.keyboard.press('Enter'); // sistema -> claro
  await expect(toggle(page)).toHaveAttribute('aria-label', /Tema: Claro/);
  expect(await isDark(page)).toBe(false);
  await page.keyboard.press('Space'); // claro -> escuro
  await expect(toggle(page)).toHaveAttribute('aria-label', /Tema: Escuro/);
  expect(await isDark(page)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('soprei-theme'))).toBe('dark');
  await page.reload();
  expect(await isDark(page)).toBe(true);
  await expect(toggle(page)).toHaveAttribute('aria-label', /Tema: Escuro/);
  await toggle(page).focus();
  await page.keyboard.press('Enter'); // escuro -> sistema (claro emulado)
  await expect(toggle(page)).toHaveAttribute('aria-label', /Tema: Sistema/);
  expect(await isDark(page)).toBe(false);
});

test('localStorage indisponível: a página funciona e o controle ainda troca o tema', async ({
  page,
}) => {
  await blockApi(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('bloqueado', 'SecurityError');
      },
    });
  });
  await page.goto('/entrar');
  await expect(page.getByLabel('E-mail', { exact: true })).toBeVisible();
  await toggle(page).click();
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-label', /Tema: Escuro/);
  expect(await isDark(page)).toBe(true);
});

test('as abas Entrar e Criar conta funcionam só pelo teclado', async ({ page }) => {
  await blockApi(page);
  await page.goto('/entrar');
  const login = page.getByRole('tab', { name: 'Entrar' });
  const register = page.getByRole('tab', { name: 'Criar conta' });
  await expect(login).toBeEnabled();
  await login.focus();
  await expect(login).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(register).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Confirmar senha')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/criar-conta');
  await page.keyboard.press('ArrowLeft');
  await expect(login).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Confirmar senha')).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/entrar');
});

for (const reduced of [true, false]) {
  test(`View Transition do tema ${reduced ? 'desligada com' : 'ligada sem'} prefers-reduced-motion`, async ({
    page,
  }) => {
    await blockApi(page);
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await page.addInitScript(() => {
      const w = window as unknown as { __vt: number };
      w.__vt = 0;
      const original = document.startViewTransition?.bind(document);
      if (original)
        document.startViewTransition = ((callback: () => void) => {
          w.__vt++;
          return original(callback);
        }) as typeof document.startViewTransition;
    });
    await page.goto('/');
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-label', /Tema: Claro/);
    const calls = await page.evaluate(() => (window as unknown as { __vt: number }).__vt);
    expect(calls).toBe(reduced ? 0 : 1);
  });
}
