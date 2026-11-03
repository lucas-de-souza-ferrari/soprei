import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('cadastro, confirmação, sessão após reload, empresas e saída', async ({ page }, testInfo) => {
  const pending = { list: undefined as Promise<void> | undefined };
  let verified = false;
  let logged = false;
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
  await page.getByLabel('Senha', { exact: true }).fill('senha-ficticia-longa');
  await page.getByRole('button', { name: 'Criar conta', exact: true }).click();
  await page.getByLabel('Código recebido por e-mail').fill('codigo-ficticio');
  await page.getByRole('button', { name: 'Confirmar e-mail', exact: true }).click();
  await page.getByLabel('Senha', { exact: true }).fill('senha-ficticia-longa');
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
    path: `test-results/accounts-${testInfo.project.name}.png`,
    fullPage: true,
  });
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
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
