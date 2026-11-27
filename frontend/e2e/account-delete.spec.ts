import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Spec 032, E7: "Excluir minha conta" na tela de empresas, com a API falsa.
for (const theme of ['light', 'dark'] as const) {
  test(`excluir a própria conta: recusas pelo código, senha errada, sucesso e volta ao login (tema ${theme})`, async ({
    page,
  }) => {
    await page.addInitScript((value) => localStorage.setItem('soprei-theme', value), theme);
    const PASSWORD = 'Senha1-da-pessoa';
    const bodies: unknown[] = [];
    const answers: { status: number; code?: string }[] = [
      { status: 401 },
      { status: 409, code: 'COMPANY_OWNERSHIP' },
      { status: 409, code: 'SUBSCRIPTION_ACTIVE' },
      { status: 409, code: 'ORDER_PENDING' },
      { status: 204 },
    ];
    let logged = true;
    await page.route('https://**/*', (route) => route.abort());
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace('/api', '');
      if (path === '/account/delete') {
        expect(request.method()).toBe('POST');
        expect(request.headers()['x-soprei-app']).toBe('web');
        bodies.push(request.postDataJSON());
        const answer = answers.shift() ?? { status: 500 };
        if (answer.status === 204) {
          logged = false;
          await route.fulfill({ status: 204 });
        } else {
          await route.fulfill({
            status: answer.status,
            json: { error: { code: answer.code ?? 'UNAUTHORIZED', message: 'texto do servidor' } },
          });
        }
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
    await page.getByRole('button', { name: 'Excluir minha conta' }).click();
    const dialog = page.getByRole('dialog', { name: 'Excluir minha conta' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('não pode ser desfeito');
    const field = dialog.getByLabel('Sua senha atual');
    await expect(field).toBeFocused();
    const confirm = dialog.getByRole('button', { name: 'Excluir conta' });
    // Sem senha, o botão fica desligado.
    await expect(confirm).toBeDisabled();

    // Esc fecha sem excluir e a senha digitada some.
    await field.fill(PASSWORD);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    expect(bodies).toEqual([]);
    await page.getByRole('button', { name: 'Excluir minha conta' }).click();
    await expect(field).toHaveValue('');

    const expected = [
      'Senha incorreta',
      'único dono de uma empresa',
      'período pago em vigor',
      'pagamento em aberto',
    ];
    for (const text of expected) {
      await field.fill(PASSWORD);
      await confirm.click();
      await expect(dialog).toContainText(text);
      // O texto do servidor nunca aparece; a senha some do campo depois de cada envio.
      await expect(dialog).not.toContainText('texto do servidor');
      await expect(field).toHaveValue('');
      await expect(page.getByText('fixa@example.test')).toBeVisible();
    }

    await field.fill(PASSWORD);
    await confirm.click();
    await expect(page.getByRole('status')).toContainText('Sua conta foi excluída');
    await expect(page.getByLabel('E-mail', { exact: true })).toBeVisible();
    await expect(page.getByText('fixa@example.test')).not.toBeVisible();
    expect(bodies).toEqual(Array.from({ length: 5 }, () => ({ password: PASSWORD })));

    // Nada da conta fica no navegador.
    const stored = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain('fixa@example.test');
    await expect(page).toHaveTitle(/^(?!.*fixa@example)/);
  });
}

test('401 com a sessão já encerrada não diz "senha incorreta": volta ao login', async ({
  page,
}) => {
  let sessionAlive = true;
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api', '');
    if (path === '/account/delete') {
      // O cookie venceu entre abrir a tela e confirmar.
      sessionAlive = false;
      await route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED' } } });
    } else if (!sessionAlive) await route.fulfill({ status: 401, json: {} });
    else if (path === '/auth/session')
      await route.fulfill({
        status: 200,
        json: { id: randomUUID(), email: 'fixa@example.test', selectedCompanyId: null },
      });
    else await route.fulfill({ status: 200, json: { items: [] } });
  });
  await page.goto('/painel/empresas');
  await page.getByRole('button', { name: 'Excluir minha conta' }).click();
  const dialog = page.getByRole('dialog', { name: 'Excluir minha conta' });
  await dialog.getByLabel('Sua senha atual').fill('Senha1-da-pessoa');
  await dialog.getByRole('button', { name: 'Excluir conta' }).click();
  await expect(page.getByRole('alert')).toContainText('Sua sessão terminou');
  await expect(page.getByLabel('E-mail', { exact: true })).toBeVisible();
  await expect(page.getByText('Senha incorreta')).not.toBeVisible();
});
