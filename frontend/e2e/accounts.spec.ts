import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

for (const theme of ['light', 'dark'] as const) {
  test(`cadastro, confirmação, sessão após reload, empresas e saída (tema ${theme})`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript((value) => localStorage.setItem('soprei-theme', value), theme);
    const pending = { list: undefined as Promise<void> | undefined };
    let verified = false;
    let logged = false;
    let registrations = 0;
    let selectedClientId: string | null = null;
    const email = 'pessoa@example.test';
    const accountId = randomUUID();
    const secondId = randomUUID();
    let currentEmail = email;
    const companies: { clientId: string; userId: string; name: string; role: string }[] = [];
    await page.route('https://**/*', (route) => route.abort());
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace('/api', '');
      const body: unknown = route.request().postDataJSON();
      let status = 204;
      let json: unknown;
      if (path === '/auth/session') {
        status = logged ? 200 : 401;
        json = logged
          ? {
              id: currentEmail === email ? accountId : secondId,
              email: currentEmail,
              selectedClientId,
            }
          : {};
      } else if (path === '/auth/register') {
        registrations++;
        status = 202;
        json = { message: 'Confira o e-mail.' };
        expect(Object.keys(body as object).sort()).toEqual(['email', 'password']);
      } else if (path === '/auth/verify-email') verified = true;
      else if (path === '/auth/login') {
        logged = verified;
        currentEmail = (body as { email: string }).email;
        status = logged ? 204 : 403;
      } else if (path === '/auth/logout') {
        logged = false;
        selectedClientId = null;
      } else if (!logged) status = 401;
      else if (path === '/account/companies' && route.request().method() === 'GET') {
        await pending.list;
        status = 200;
        json = { items: currentEmail === email ? companies : [] };
      } else if (path === '/account/companies') {
        status = 201;
        json = {
          clientId: randomUUID(),
          userId: randomUUID(),
          name: (body as { name: string }).name,
          role: 'OWNER',
        };
        companies.push(json as (typeof companies)[number]);
      } else if (path.endsWith('/select')) selectedClientId = path.split('/')[3] ?? null;
      else status = 404;
      await route.fulfill({ status, ...(status === 204 ? {} : { json: json ?? {} }) });
    });
    await page.goto('/criar-conta');
    await expect(page.getByRole('button', { name: 'Criar conta', exact: true })).toBeEnabled();
    await page.getByLabel('E-mail', { exact: true }).fill(email);
    await page.getByLabel('Senha', { exact: true }).fill('Senha1');
    await page.getByLabel('Confirmar senha').fill('Senha2');
    await page.getByRole('button', { name: 'Mostrar senha', exact: true }).click();
    await expect(page.getByLabel('Senha', { exact: true })).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Ocultar senha', exact: true }).click();
    await page.getByRole('button', { name: 'Mostrar confirmação de senha' }).click();
    await expect(page.getByLabel('Confirmar senha')).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Ocultar confirmação de senha' }).click();
    await page.getByRole('button', { name: 'Criar conta', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('As senhas não coincidem');
    await page.getByLabel('Senha', { exact: true }).fill('senha1');
    await page.getByLabel('Confirmar senha').fill('senha1');
    await page.getByRole('button', { name: 'Criar conta', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('uma letra maiúscula e um número');
    expect(registrations).toBe(0);
    await page.getByLabel('Senha', { exact: true }).fill('Senha1');
    await page.getByLabel('Confirmar senha').fill('Senha1');
    await page.getByRole('button', { name: 'Criar conta', exact: true }).click();
    await page.getByLabel('Código recebido por e-mail').fill('codigo-ficticio');
    await page.getByRole('button', { name: 'Confirmar e-mail', exact: true }).click();
    await page.getByLabel('Senha', { exact: true }).fill('Senha1');
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page.getByText('Você ainda não tem empresas.', { exact: false })).toBeVisible();
    await page.getByLabel('Nome da empresa').fill('Minha primeira empresa');
    await page.getByRole('button', { name: 'Criar empresa', exact: true }).click();
    await expect(page.getByText('Minha primeira empresa')).toBeVisible();
    await page.getByRole('button', { name: 'Selecionar', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Selecionada ✓' })).toBeVisible();
    await page.reload();
    await expect(page.getByText('Minha primeira empresa')).toBeVisible();
    await page.screenshot({
      path: `test-results/accounts-${testInfo.project.name}-${theme}.png`,
      fullPage: true,
    });
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark).*$/);
    // Só a preferência de tema pode estar no armazenamento do navegador.
    expect(
      await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]),
    ).toEqual(['soprei-theme']);
    let releaseList: (() => void) | undefined;
    pending.list = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const pendingList = page.waitForRequest(
      (request) => request.url().endsWith('/api/account/companies') && request.method() === 'GET',
    );
    await page.getByLabel('Nome da empresa').fill('Rascunho privado de A');
    await page.getByRole('button', { name: 'Selecionada ✓' }).click();
    await pendingList;
    const lateResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/account/companies') && response.request().method() === 'GET',
    );
    await page.getByRole('button', { name: 'Sair', exact: true }).click();
    releaseList?.();
    await lateResponse;
    await expect(page.getByText('Minha primeira empresa')).not.toBeVisible();
    await expect(page.getByLabel('E-mail', { exact: true })).toBeVisible();
    await expect(page.getByLabel('E-mail', { exact: true })).toHaveValue('');
    await page.getByLabel('E-mail', { exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Senha', { exact: true })).toBeFocused();
    // A API falsa possui uma segunda conta já confirmada, sem empresas.
    await page.getByLabel('E-mail', { exact: true }).fill('outra@example.test');
    await page.getByLabel('Senha', { exact: true }).fill('senha-ficticia-longa');
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page.getByText('outra@example.test')).toBeVisible();
    await expect(page.getByText('Minha primeira empresa')).not.toBeVisible();
    await expect(page.getByLabel('Nome da empresa')).toHaveValue('');
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`saída não confirmada pelo servidor mantém a sessão e permite tentar de novo (tema ${theme})`, async ({
    page,
  }) => {
    await page.addInitScript((value) => localStorage.setItem('soprei-theme', value), theme);
    let logoutAttempts = 0;
    let logged = true;
    await page.route('https://**/*', (route) => route.abort());
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace('/api', '');
      if (path === '/auth/logout') {
        logoutAttempts++;
        if (logoutAttempts === 1) {
          await route.fulfill({ status: 503, json: {} });
          return;
        }
        logged = false;
        await route.fulfill({ status: 204 });
      } else if (!logged) await route.fulfill({ status: 401, json: {} });
      else if (path === '/auth/session')
        await route.fulfill({
          status: 200,
          json: { id: randomUUID(), email: 'fixa@example.test', selectedClientId: null },
        });
      else await route.fulfill({ status: 200, json: { items: [] } });
    });
    await page.goto('/painel/empresas');
    await expect(page.getByText('fixa@example.test')).toBeVisible();
    await page.getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Saída não confirmada');
    await expect(page.getByText('fixa@example.test')).toBeVisible();
    await page.getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(page.getByLabel('E-mail', { exact: true })).toBeVisible();
    await expect(page.getByText('fixa@example.test')).not.toBeVisible();
    expect(logoutAttempts).toBe(2);
  });
}
