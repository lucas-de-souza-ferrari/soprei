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
    const verifyBodies: unknown[] = [];
    let selectedCompanyId: string | null = null;
    const email = 'pessoa@example.test';
    const accountId = randomUUID();
    const secondId = randomUUID();
    let currentEmail = email;
    const companies: { companyId: string; membershipId: string; name: string; role: string }[] = [];
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
              selectedCompanyId,
            }
          : {};
      } else if (path === '/auth/register') {
        registrations++;
        status = 202;
        json = { message: 'Confira o e-mail.' };
        expect(Object.keys(body as object).sort()).toEqual(['email', 'password']);
      } else if (path === '/auth/verify-email') {
        verifyBodies.push(body);
        verified = true;
      } else if (path === '/auth/login') {
        logged = verified;
        currentEmail = (body as { email: string }).email;
        status = logged ? 204 : 403;
      } else if (path === '/auth/logout') {
        logged = false;
        selectedCompanyId = null;
      } else if (!logged) status = 401;
      else if (path === '/account/companies' && route.request().method() === 'GET') {
        await pending.list;
        status = 200;
        json = { items: currentEmail === email ? companies : [] };
      } else if (path === '/account/companies') {
        status = 201;
        json = {
          companyId: randomUUID(),
          membershipId: randomUUID(),
          name: (body as { name: string }).name,
          role: 'OWNER',
        };
        companies.push(json as (typeof companies)[number]);
      } else if (path.endsWith('/select')) selectedCompanyId = path.split('/')[3] ?? null;
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
    await expect(page.getByRole('alert')).toHaveCount(1);
    await expect(page.getByRole('alert')).toContainText('As senhas não coincidem');
    await page.getByLabel('Senha', { exact: true }).fill('senha1');
    await page.getByLabel('Confirmar senha').fill('senha1');
    await page.getByRole('button', { name: 'Criar conta', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(1);
    await expect(page.getByRole('alert')).toContainText('uma letra maiúscula e um número');
    expect(registrations).toBe(0);
    await page.getByLabel('Senha', { exact: true }).fill('Senha1');
    await page.getByLabel('Confirmar senha').fill('Senha1');
    await page.getByRole('button', { name: 'Criar conta', exact: true }).click();
    const codeField = page.getByLabel('Código recebido por e-mail');
    await expect(codeField).toHaveAttribute('inputmode', 'numeric');
    await expect(codeField).toHaveAttribute('autocomplete', 'one-time-code');
    // Letras são descartadas; com menos de 6 dígitos nada é enviado.
    await codeField.fill('abc12');
    await expect(codeField).toHaveValue('12');
    await page.getByRole('button', { name: 'Confirmar e-mail', exact: true }).click();
    await expect(page.getByText('Digite os 6 dígitos do código')).toBeVisible();
    expect(verifyBodies).toHaveLength(0);
    // Colar com separadores normaliza para 6 dígitos.
    await codeField.fill('123 456');
    await expect(codeField).toHaveValue('123456');
    await codeField.fill('123-456');
    await expect(codeField).toHaveValue('123456');
    await codeField.fill('123456');
    await page.getByRole('button', { name: 'Confirmar e-mail', exact: true }).click();
    await expect.poll(() => verifyBodies.length).toBe(1);
    expect(verifyBodies[0]).toEqual({ email, password: 'Senha1', code: '123456' });
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
          json: { id: randomUUID(), email: 'fixa@example.test', selectedCompanyId: null },
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

for (const theme of ['light', 'dark'] as const) {
  test(`recuperação de senha: pedido neutro, código, nova senha e volta ao login (tema ${theme})`, async ({
    page,
  }) => {
    await page.addInitScript((value) => localStorage.setItem('soprei-theme', value), theme);
    const requests: unknown[] = [];
    const confirms: unknown[] = [];
    let requestStatus = 202;
    await page.route('https://**/*', (route) => route.abort());
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace('/api', '');
      const body: unknown = route.request().postDataJSON();
      if (path === '/auth/password-reset/request') {
        requests.push(body);
        await route.fulfill({ status: requestStatus, json: { message: 'x' } });
      } else if (path === '/auth/password-reset/confirm') {
        confirms.push(body);
        if (confirms.length === 1) await route.fulfill({ status: 401, json: { error: {} } });
        else await route.fulfill({ status: 204 });
      } else await route.fulfill({ status: 401, json: {} });
    });
    await page.goto('/entrar');
    await page.getByRole('button', { name: 'Esqueci minha senha', exact: true }).click();
    await expect(page).toHaveURL(/\/recuperar-senha$/);
    await page.getByLabel('E-mail', { exact: true }).fill('pessoa@example.test');
    // Mesmo um 4xx (que não seja 429) mostra a mensagem neutra.
    requestStatus = 404;
    await page.getByRole('button', { name: 'Enviar código', exact: true }).click();
    const neutral = 'Se existir uma conta, enviamos um código para o e-mail informado.';
    await expect(page.getByRole('status')).toContainText(neutral);
    requestStatus = 429;
    await page.getByRole('button', { name: 'Enviar código', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Muitas tentativas');
    requestStatus = 202;
    await page.getByRole('button', { name: 'Enviar código', exact: true }).click();
    await expect(page.getByRole('status')).toContainText(neutral);
    expect(requests).toEqual([
      { email: 'pessoa@example.test' },
      { email: 'pessoa@example.test' },
      { email: 'pessoa@example.test' },
    ]);
    await page.getByRole('button', { name: 'Já tenho um código', exact: true }).click();
    await expect(page).toHaveURL(/\/redefinir-senha$/);
    const codeField = page.getByLabel('Código recebido por e-mail');
    await codeField.fill('123 45');
    await expect(codeField).toHaveValue('12345');
    // Entrada inválida nunca chama a API.
    await page.getByLabel('Nova senha', { exact: true }).fill('Senha1');
    await page.getByLabel('Confirmar nova senha').fill('Senha1');
    await page.getByRole('button', { name: 'Redefinir senha', exact: true }).click();
    await expect(page.getByText('Digite os 6 dígitos do código')).toBeVisible();
    await codeField.fill('123-456');
    await expect(codeField).toHaveValue('123456');
    await page.getByLabel('Nova senha', { exact: true }).fill('curta');
    await page.getByLabel('Confirmar nova senha').fill('curta');
    await page.getByRole('button', { name: 'Redefinir senha', exact: true }).click();
    await expect(page.getByText('Use pelo menos 6 caracteres')).toBeVisible();
    await page.getByLabel('Nova senha', { exact: true }).fill('Senha1');
    await page.getByLabel('Confirmar nova senha').fill('Senha2');
    await page.getByRole('button', { name: 'Redefinir senha', exact: true }).click();
    await expect(page.getByText('As senhas não coincidem')).toBeVisible();
    expect(confirms).toHaveLength(0);
    await page.getByRole('button', { name: 'Mostrar senha', exact: true }).click();
    await expect(page.getByLabel('Nova senha', { exact: true })).toHaveAttribute('type', 'text');
    await page.getByLabel('Confirmar nova senha').fill('Senha1');
    // Primeira tentativa: código recusado pelo servidor.
    await page.getByRole('button', { name: 'Redefinir senha', exact: true }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Código inválido ou expirado' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Redefinir senha', exact: true }).click();
    await expect(page.getByRole('status')).toContainText(
      'Senha redefinida. Entre com a nova senha.',
    );
    expect(confirms).toEqual([
      { email: 'pessoa@example.test', code: '123456', newPassword: 'Senha1' },
      { email: 'pessoa@example.test', code: '123456', newPassword: 'Senha1' },
    ]);
    // Sem login automático: volta à entrada com a senha vazia.
    await expect(page).toHaveURL(/\/entrar$/);
    await expect(page.getByLabel('Senha', { exact: true })).toHaveValue('');
    expect(
      await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]),
    ).toEqual(['soprei-theme']);
  });
}
