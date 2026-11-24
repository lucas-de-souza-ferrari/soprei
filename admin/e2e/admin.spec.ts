import { test, expect, type Page } from '@playwright/test';
import { ACCOUNT_A, ADMIN_EMAIL, COMPANY_A, FULL_EMAIL } from './fixtures';
import { GOOD, hasHorizontalScroll, installFakeApi, signIn, storageSizes } from './fake-api';

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name, exact: true });

test('entrar com e-mail, senha e código e ver a Visão geral, sem nada guardado no navegador', async ({
  page,
}) => {
  const api = await installFakeApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Soprei Admin' })).toBeVisible();
  const code = page.getByLabel('Código do autenticador');
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(code).toHaveAttribute('inputmode', 'numeric');

  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
  await expect(page.getByText(ADMIN_EMAIL)).toBeVisible();
  await expect(page.getByText('1.234', { exact: true })).toBeVisible();

  const [login] = api.callsTo('POST', '/platform/auth/login');
  expect(login?.body).toEqual(GOOD);
  expect(login?.headers['x-soprei-app']).toBe('admin');
  expect(login?.headers['content-type']).toBe('application/json');
  expect(await storageSizes(page)).toEqual([0, 0]);
  expect(await page.title()).toBe('Soprei Admin');
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/');
});

test('credenciais erradas: mensagem única, senha e código apagados, nada de texto do servidor', async ({
  page,
}) => {
  await installFakeApi(page);
  await page.goto('/');
  await page.getByLabel('E-mail').fill(GOOD.email);
  await page.getByLabel('Senha').fill('senha-errada-mas-longa');
  await page.getByLabel('Código do autenticador').fill('12 34 56');
  await expect(page.getByLabel('Código do autenticador')).toHaveValue('123456');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('alert')).toHaveText('E-mail, senha ou código incorretos.');
  await expect(page.getByLabel('Senha')).toHaveValue('');
  await expect(page.getByLabel('Código do autenticador')).toHaveValue('');
  await expect(page.getByText('texto do servidor')).toHaveCount(0);
});

test('abrir uma empresa e suspender com confirmação e motivo; depois reativar', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await nav(page, 'Empresas').click();
  await page.getByRole('button', { name: 'Abrir Padaria Aurora' }).click();
  await expect(page.getByRole('heading', { name: 'Padaria Aurora', level: 1 })).toBeVisible();
  await expect(page.getByText('1.250 de 5.000 (25%)')).toBeVisible();

  // Cancelar não chama a rota.
  await page.getByRole('button', { name: 'Suspender', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Suspender Padaria Aurora?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toBeHidden();
  expect(api.callsTo('POST', `/platform/companies/${COMPANY_A}/suspend`)).toHaveLength(0);

  await page.getByRole('button', { name: 'Suspender', exact: true }).click();
  await dialog.getByLabel('Motivo').selectOption({ label: 'Abuso' });
  await dialog.getByRole('button', { name: 'Confirmar suspensão' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Reativar', exact: true })).toBeVisible();
  const [suspend] = api.callsTo('POST', `/platform/companies/${COMPANY_A}/suspend`);
  expect(suspend?.body).toEqual({ reason: 'ABUSE' });
  expect(suspend?.headers['x-soprei-app']).toBe('admin');

  await page.getByRole('button', { name: 'Reativar', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmar reativação' }).click();
  await expect(page.getByRole('button', { name: 'Suspender', exact: true })).toBeVisible();
  const [reactivate] = api.callsTo('POST', `/platform/companies/${COMPANY_A}/reactivate`);
  expect(reactivate?.body).toEqual({ reason: 'PAYMENT' });
});

test('401 em qualquer chamada volta à tela Entrar', async ({ page }) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
  api.expired.add('/platform/overview');
  await page.getByRole('button', { name: 'Atualizar' }).click();
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Sessão encerrada. Entre novamente.');
  expect(await storageSizes(page)).toEqual([0, 0]);
});

test('"Mostrar e-mail" chama a rota de detalhe da conta; a lista só tem o e-mail mascarado', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await nav(page, 'Contas').click();
  await expect(page.getByText('l***@exemplo.test')).toBeVisible();
  await page.getByRole('button', { name: 'Abrir conta l***@exemplo.test' }).click();
  await expect(page.getByText(FULL_EMAIL)).toHaveCount(0);
  expect(api.callsTo('GET', `/platform/accounts/${ACCOUNT_A}`)).toHaveLength(0);

  await page.getByRole('button', { name: 'Mostrar e-mail' }).click();
  await expect(page.getByText(FULL_EMAIL)).toBeVisible();
  expect(api.callsTo('GET', `/platform/accounts/${ACCOUNT_A}`)).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Abrir Padaria Aurora' })).toBeVisible();
  expect(page.url()).not.toContain(ACCOUNT_A);
  expect(await page.title()).toBe('Soprei Admin');
});

test('"Precisa de atenção" leva à lista de empresas filtrada', async ({ page }) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await page.getByRole('button', { name: /Canais com token inválido/ }).click();
  await expect(page.getByRole('heading', { name: 'Empresas' })).toBeVisible();
  await expect(page.getByLabel('Precisa de atenção')).toHaveValue('token_invalid');
  await expect(page.getByRole('button', { name: 'Abrir Oficina Boa Vista' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Abrir Padaria Aurora' })).toHaveCount(0);
  const last = api.callsTo('GET', '/platform/companies').at(-1);
  expect(last?.search.get('attention')).toBe('token_invalid');
});

test('filtros vão ao servidor em minúsculas (os validadores da E2 recusam outro valor)', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await page.getByRole('button', { name: /Suspensas/ }).click();
  await expect(page.getByLabel('Estado')).toHaveValue('suspended');
  await expect
    .poll(() => api.callsTo('GET', '/platform/companies').at(-1)?.search.get('status'))
    .toBe('suspended');

  await nav(page, 'Contas').click();
  await page.getByRole('combobox', { name: 'E-mail' }).selectOption({ label: 'Não confirmado' });
  await expect
    .poll(() => api.callsTo('GET', '/platform/accounts').at(-1)?.search.get('verified'))
    .toBe('false');

  await nav(page, 'Cobrança').click();
  await expect(page.getByText(/149,00/)).toBeVisible();
  await page.getByLabel('Situação').selectOption({ label: 'Pago' });
  await page.getByLabel('Tipo').selectOption({ label: 'Pacote extra' });
  await expect
    .poll(() => {
      const search = api.callsTo('GET', '/platform/billing/orders').at(-1)?.search;
      return [search?.get('status'), search?.get('kind')];
    })
    .toEqual(['paid', 'extra_pack']);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('cobrança desligada aparece como tal na Visão geral e na Cobrança', async ({ page }) => {
  await installFakeApi(page, { signedIn: true, billingEnabled: false });
  await page.goto('/');
  await expect(page.getByText('Cobrança desligada.')).toBeVisible();
  await nav(page, 'Cobrança').click();
  await expect(page.getByText('Cobrança desligada.')).toHaveCount(2);
});

test('Saúde: fila indisponível sem derrubar o resto, e releitura a cada 60 s só com a aba visível', async ({
  page,
}) => {
  await page.clock.install();
  const api = await installFakeApi(page, { signedIn: true, queueUnavailable: true });
  await page.goto('/');
  await nav(page, 'Saúde').click();
  await expect(page.getByText('Indisponível')).toBeVisible();
  await expect(page.getByText('Envios pelo canal: ok')).toBeVisible();
  // Em desenvolvimento o StrictMode do React monta a tela duas vezes; conta-se a partir daqui.
  const reads = () => api.callsTo('GET', '/platform/health').length;
  const first = reads();

  await page.clock.fastForward(59_000);
  expect(reads()).toBe(first);
  await page.clock.fastForward(1_000);
  await expect.poll(reads).toBe(first + 1);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  });
  await page.clock.fastForward(120_000);
  await page.clock.runFor(1_000);
  expect(reads()).toBe(first + 1);
});

test('nenhuma tela rola de lado e o tema segue o sistema', async ({ page }, testInfo) => {
  await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
  const dark = testInfo.project.use.colorScheme === 'dark';
  const background = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--background').trim(),
  );
  expect(background).toBe(dark ? '#0b131c' : '#f9faf8');

  expect(await hasHorizontalScroll(page)).toBe(false);
  for (const [section, heading] of [
    ['Empresas', 'Empresas'],
    ['Contas', 'Contas'],
    ['Cobrança', 'Cobrança'],
    ['Canal', 'Canal'],
    ['Saúde', 'Saúde'],
  ] as const) {
    await nav(page, section).click();
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    expect(await hasHorizontalScroll(page), section).toBe(false);
  }
  await nav(page, 'Empresas').click();
  await page.getByRole('button', { name: 'Abrir Padaria Aurora' }).click();
  await expect(page.getByRole('heading', { name: 'Padaria Aurora', level: 1 })).toBeVisible();
  expect(await hasHorizontalScroll(page), 'detalhe da empresa').toBe(false);
  await page.getByRole('button', { name: 'Suspender', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await hasHorizontalScroll(page), 'diálogo').toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  expect(await hasHorizontalScroll(page), 'Entrar').toBe(false);
  expect(await storageSizes(page)).toEqual([0, 0]);
});
