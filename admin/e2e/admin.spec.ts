import { test, expect, type Page } from '@playwright/test';
import { ACCOUNT_A, ADMIN_EMAIL, COMPANY_A, FULL_EMAIL } from './fixtures';
import {
  FRESH_CODE,
  GOOD,
  hasHorizontalScroll,
  installFakeApi,
  signIn,
  storageSizes,
  type FakeApi,
  type FakeApiOptions,
} from './fake-api';

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name, exact: true });

const CLOCK_START = new Date('2026-11-24T15:00:00.000Z');

/**
 * Abre a Saúde com o relógio da página parado (`pauseAt`) antes de a tela montar: o intervalo de 60 s
 * começa num instante conhecido, e só `runFor` o faz andar (nada depende do relógio real da máquina).
 */
async function openHealthWithFrozenClock(
  page: Page,
  options: FakeApiOptions = {},
): Promise<FakeApi> {
  await page.clock.install({ time: CLOCK_START });
  const api = await installFakeApi(page, { signedIn: true, ...options });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 5 * 60_000));
  await nav(page, 'Saúde').click();
  await expect(page.getByRole('heading', { name: 'Saúde', level: 1 })).toBeVisible();
  return api;
}

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

test('com a suspensão em andamento, Esc não fecha o diálogo e o erro da ação aparece', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  const path = `/platform/companies/${COMPANY_A}/suspend`;
  api.failures.set(path, 503);
  let release: () => void = () => undefined;
  api.holds.set(
    path,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await page.goto('/');
  await nav(page, 'Empresas').click();
  await page.getByRole('button', { name: 'Abrir Padaria Aurora' }).click();
  await page.getByRole('button', { name: 'Suspender', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Suspender Padaria Aurora?' });
  await dialog.getByRole('button', { name: 'Confirmar suspensão' }).click();
  await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();

  release();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Serviço indisponível no momento. Tente novamente em instantes.',
  );
  // Fechado o diálogo, o erro continua à vista fora dele.
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('alert')).toHaveText(
    'Serviço indisponível no momento. Tente novamente em instantes.',
  );
  expect(api.callsTo('POST', path)).toHaveLength(1);
});

test('401 em qualquer chamada volta à tela Entrar', async ({ page }) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
  // Espera a carga inicial terminar (o StrictMode de desenvolvimento carrega duas vezes).
  await expect(page.getByRole('button', { name: 'Atualizar' })).toBeEnabled();
  api.expired.add('/platform/overview');
  await page.getByRole('button', { name: 'Atualizar' }).click();
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Sessão encerrada. Entre novamente.');
  expect(await storageSizes(page)).toEqual([0, 0]);
});

test('"Sair" que o servidor não confirma (503) mantém a sessão na tela e mostra o erro', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
  api.failures.set('/platform/auth/logout', 503);
  let release: () => void = () => undefined;
  api.holds.set(
    '/platform/auth/logout',
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page.getByRole('button', { name: 'Saindo…' })).toBeDisabled();
  release();
  await expect(page.getByRole('alert')).toContainText('Não foi possível sair');
  await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
  await expect(page.getByText(ADMIN_EMAIL)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sair' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Entrar' })).toHaveCount(0);
  expect(api.callsTo('POST', '/platform/auth/logout')).toHaveLength(1);
});

test('"Sair" com 401 do servidor conta como saída concluída', async ({ page }) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
  api.failures.set('/platform/auth/logout', 401);
  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('login aceito (204) mas sessão 401 em seguida: aviso de cookie não guardado em Entrar', async ({
  page,
}) => {
  const api = await installFakeApi(page);
  api.failures.set('/platform/auth/session', 401);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  // Ao abrir, um 401 é só "sem sessão": nenhum aviso.
  await expect(page.getByRole('status')).toHaveCount(0);
  await signIn(page);
  await expect(page.getByRole('status')).toHaveText(
    'O servidor aceitou a entrada, mas o navegador não guardou a sessão (cookie seguro). Confira o endereço do admin.',
  );
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  expect(api.callsTo('POST', '/platform/auth/login')).toHaveLength(1);
});

test('conta: o detalhe abre mascarado; só "Mostrar e-mail" chama a rota auditada (spec 045, D3)', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await nav(page, 'Contas').click();
  await page.getByRole('combobox', { name: 'Estado' }).selectOption({ label: 'Ativas' });
  await expect(page.getByText('l***@exemplo.test')).toBeVisible();
  await page.getByRole('button', { name: 'Abrir conta l***@exemplo.test' }).click();
  await expect(page.getByRole('heading', { name: 'Conta', level: 1 })).toBeVisible();
  // O detalhe (mascarado) já traz as empresas e a assinatura; o e-mail completo não.
  await expect(page.getByRole('button', { name: 'Abrir Padaria Aurora' })).toBeVisible();
  await expect(page.getByText('l***@exemplo.test')).toBeVisible();
  await expect(page.getByText(FULL_EMAIL)).toHaveCount(0);
  await expect
    .poll(() => api.callsTo('GET', `/platform/accounts/${ACCOUNT_A}`).length)
    .toBeGreaterThan(0);
  expect(api.callsTo('GET', `/platform/accounts/${ACCOUNT_A}/email`)).toHaveLength(0);

  await page.getByRole('button', { name: 'Mostrar e-mail' }).click();
  await expect(page.getByText(FULL_EMAIL)).toBeVisible();
  expect(api.callsTo('GET', `/platform/accounts/${ACCOUNT_A}/email`)).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Mostrar e-mail' })).toHaveCount(0);
  expect(page.url()).not.toContain(ACCOUNT_A);
  expect(await page.title()).toBe('Soprei Admin');
  expect(await storageSizes(page)).toEqual([0, 0]);

  // Voltar devolve a lista com o filtro de antes.
  await page.getByRole('button', { name: 'Voltar' }).click();
  await expect(page.getByRole('combobox', { name: 'Estado' })).toHaveValue('active');
  await expect(page.getByText(FULL_EMAIL)).toHaveCount(0);
});

test('conta: 401 em "Mostrar e-mail" volta à tela Entrar sem nada no navegador', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  api.expired.add(`/platform/accounts/${ACCOUNT_A}/email`);
  await page.goto('/');
  await nav(page, 'Contas').click();
  await page.getByRole('button', { name: 'Abrir conta l***@exemplo.test' }).click();
  await expect(page.getByRole('heading', { name: 'Conta', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Mostrar e-mail' }).click();
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Sessão encerrada. Entre novamente.');
  await expect(page.getByText(FULL_EMAIL)).toHaveCount(0);
  expect(api.callsTo('GET', `/platform/accounts/${ACCOUNT_A}/email`)).toHaveLength(1);
  expect(await storageSizes(page)).toEqual([0, 0]);
});

/** Abre o detalhe da conta A pela lista de contas. */
async function openAccount(page: Page): Promise<void> {
  await nav(page, 'Contas').click();
  await page.getByRole('button', { name: 'Abrir conta l***@exemplo.test' }).click();
  await expect(page.getByRole('heading', { name: 'Conta', level: 1 })).toBeVisible();
}

test('conta: desativar pede motivo e código novo (o do login é recusado), envia o corpo esperado e relê; reativar não pede código (spec 045, E2)', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await openAccount(page);
  const path = `/platform/accounts/${ACCOUNT_A}`;
  // Conta ativa e confirmada: sem "Reenviar código de confirmação".
  await expect(
    page.getByRole('button', { name: 'Enviar código de recuperação de senha' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reenviar código de confirmação' })).toHaveCount(0);

  // Cancelar não chama a rota.
  await page.getByRole('button', { name: 'Desativar conta' }).click();
  const dialog = page.getByRole('dialog', { name: 'Desativar a conta?' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText('A pessoa perde o acesso a todas as empresas na hora', { exact: false }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toBeHidden();
  expect(api.callsTo('POST', `${path}/disable`)).toHaveLength(0);

  await page.getByRole('button', { name: 'Desativar conta' }).click();
  const confirm = dialog.getByRole('button', { name: 'Confirmar desativação' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Motivo').selectOption({ label: 'Abuso' });
  const code = dialog.getByLabel('Código novo do autenticador');
  await code.fill(GOOD.code);
  await confirm.click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Código do autenticador inválido ou já usado',
  );
  await expect(code).toHaveValue('');
  expect(await hasHorizontalScroll(page)).toBe(false);

  await code.fill(FRESH_CODE);
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status')).toHaveText('Conta desativada e sessões encerradas.');
  await expect(page.getByText('Desativada', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reativar conta' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Enviar código de recuperação de senha' }),
  ).toHaveCount(0);
  const calls = api.callsTo('POST', `${path}/disable`);
  expect(calls.map((call) => call.body)).toEqual([
    { reason: 'ABUSE', code: GOOD.code },
    { reason: 'ABUSE', code: FRESH_CODE },
  ]);
  expect(calls[1]?.headers['x-soprei-app']).toBe('admin');
  await expect(page.getByText(FRESH_CODE)).toHaveCount(0);

  await page.getByRole('button', { name: 'Reativar conta' }).click();
  const enable = page.getByRole('dialog', { name: 'Reativar a conta?' });
  await expect(enable.getByLabel('Código novo do autenticador')).toHaveCount(0);
  await enable.getByRole('button', { name: 'Confirmar reativação' }).click();
  await expect(enable).toBeHidden();
  await expect(page.getByRole('button', { name: 'Desativar conta' })).toBeVisible();
  expect(api.callsTo('POST', `${path}/enable`).map((call) => call.body)).toEqual([
    { reason: 'OWNER_REQUEST' },
  ]);
  expect(await storageSizes(page)).toEqual([0, 0]);
});

test('conta: única dona ativa de empresa ativa, desativar mostra o motivo da recusa (409 LAST_OWNER) e nada muda', async ({
  page,
}) => {
  await installFakeApi(page, { signedIn: true, lastOwner: true });
  await page.goto('/');
  await openAccount(page);
  await page.getByRole('button', { name: 'Desativar conta' }).click();
  const dialog = page.getByRole('dialog', { name: 'Desativar a conta?' });
  await dialog.getByLabel('Código novo do autenticador').fill(FRESH_CODE);
  await dialog.getByRole('button', { name: 'Confirmar desativação' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Esta conta é a única dona ativa de uma empresa ativa. Suspenda a empresa ou transfira a propriedade antes.',
  );
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByRole('button', { name: 'Desativar conta' })).toBeVisible();
});

test('conta: encerrar sessões e enviar código de recuperação com motivo; o aviso diz o que acontece', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await openAccount(page);
  const path = `/platform/accounts/${ACCOUNT_A}`;

  await page.getByRole('button', { name: 'Encerrar sessões' }).click();
  const sessions = page.getByRole('dialog', { name: 'Encerrar as sessões da conta?' });
  await sessions.getByLabel('Motivo').selectOption({ label: 'Outro' });
  await sessions.getByRole('button', { name: 'Encerrar sessões' }).click();
  await expect(sessions).toBeHidden();
  await expect(page.getByRole('status')).toHaveText('Sessões encerradas.');
  expect(api.callsTo('POST', `${path}/sessions/revoke`).map((call) => call.body)).toEqual([
    { reason: 'OTHER' },
  ]);

  await page.getByRole('button', { name: 'Enviar código de recuperação de senha' }).click();
  const reset = page.getByRole('dialog', { name: 'Enviar código de recuperação de senha?' });
  await expect(
    reset.getByText('Você não vê o código nem a senha.', { exact: false }),
  ).toBeVisible();
  await reset.getByRole('button', { name: 'Enviar código' }).click();
  await expect(reset).toBeHidden();
  await expect(page.getByRole('status')).toHaveText(
    'Pedido registrado: o código sai por e-mail se a conta estiver apta.',
  );
  expect(api.callsTo('POST', `${path}/password-reset`).map((call) => call.body)).toEqual([
    { reason: 'OWNER_REQUEST' },
  ]);
});

test('conta não confirmada: só ela mostra "Reenviar código de confirmação"; o pedido vai com o motivo', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  api.accountVerified = false;
  await page.goto('/');
  await openAccount(page);
  await expect(
    page.getByRole('button', { name: 'Enviar código de recuperação de senha' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Reenviar código de confirmação' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reenviar o código de confirmação?' });
  await dialog.getByRole('button', { name: 'Reenviar código' }).click();
  await expect(dialog).toBeHidden();
  expect(
    api
      .callsTo('POST', `/platform/accounts/${ACCOUNT_A}/verification/resend`)
      .map((call) => call.body),
  ).toEqual([{ reason: 'OWNER_REQUEST' }]);
});

test('conta: 503 em desativar ou encerrar sessões relê o detalhe e diz que a ação pode ter sido registrada sem encerrar as sessões (revisão da E2)', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  api.revocationDown = true;
  await page.goto('/');
  await openAccount(page);
  const detailPath = `/platform/accounts/${ACCOUNT_A}`;
  const partial =
    'A ação pode ter sido registrada sem que as sessões tenham sido encerradas: repita para concluir.';

  const reads = api.callsTo('GET', detailPath).length;
  await page.getByRole('button', { name: 'Desativar conta' }).click();
  const dialog = page.getByRole('dialog', { name: 'Desativar a conta?' });
  await dialog.getByLabel('Código novo do autenticador').fill(FRESH_CODE);
  await dialog.getByRole('button', { name: 'Confirmar desativação' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(partial);
  // O detalhe foi relido: a conta aparece desativada (a mudança foi gravada).
  await expect.poll(() => api.callsTo('GET', detailPath).length).toBeGreaterThan(reads);
  await expect(page.getByText('Desativada', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByRole('alert')).toHaveText(partial);

  const before = api.callsTo('GET', detailPath).length;
  await page.getByRole('button', { name: 'Encerrar sessões' }).click();
  const sessions = page.getByRole('dialog', { name: 'Encerrar as sessões da conta?' });
  await sessions.getByRole('button', { name: 'Encerrar sessões' }).click();
  await expect(sessions.getByRole('alert')).toHaveText(partial);
  await expect.poll(() => api.callsTo('GET', detailPath).length).toBeGreaterThan(before);
});

test('conta: 429 no diálogo de desativar e 409 ALREADY_VERIFIED no reenvio aparecem com a mensagem própria', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  api.accountVerified = false;
  const disablePath = `/platform/accounts/${ACCOUNT_A}/disable`;
  api.failures.set(disablePath, 429);
  await page.goto('/');
  await openAccount(page);

  await page.getByRole('button', { name: 'Desativar conta' }).click();
  const dialog = page.getByRole('dialog', { name: 'Desativar a conta?' });
  await dialog.getByLabel('Código novo do autenticador').fill(FRESH_CODE);
  await dialog.getByRole('button', { name: 'Confirmar desativação' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Muitas tentativas. Aguarde antes de tentar novamente.',
  );
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByRole('button', { name: 'Desativar conta' })).toBeVisible();

  // A conta foi confirmada por outro caminho depois de a tela abrir: o servidor recusa o reenvio.
  api.accountVerified = true;
  await page.getByRole('button', { name: 'Reenviar código de confirmação' }).click();
  const resend = page.getByRole('dialog', { name: 'Reenviar o código de confirmação?' });
  await resend.getByRole('button', { name: 'Reenviar código' }).click();
  await expect(resend.getByRole('alert')).toHaveText('O e-mail desta conta já está confirmado.');
});

test('conta: 401 numa ação volta à tela Entrar sem nada no navegador', async ({ page }) => {
  const api = await installFakeApi(page, { signedIn: true });
  api.expired.add(`/platform/accounts/${ACCOUNT_A}/sessions/revoke`);
  await page.goto('/');
  await openAccount(page);
  await page.getByRole('button', { name: 'Encerrar sessões' }).click();
  await page
    .getByRole('dialog', { name: 'Encerrar as sessões da conta?' })
    .getByRole('button', { name: 'Encerrar sessões' })
    .click();
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Sessão encerrada. Entre novamente.');
  expect(await storageSizes(page)).toEqual([0, 0]);
});

test('empresa: o dono em destaque, a seção Pessoas e "Abrir conta" sem ler o e-mail completo (spec 045, E1)', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await nav(page, 'Empresas').click();
  // Coluna Dono na lista; a empresa sem dono ativo tem o selo.
  const rowA = page.getByRole('button', { name: 'Abrir Padaria Aurora' });
  await expect(rowA).toContainText('Dono: l***@exemplo.test');
  const rowB = page.getByRole('button', { name: 'Abrir Oficina Boa Vista' });
  await expect(rowB).toContainText('Sem dono ativo');
  await expect(rowB).toContainText('Dono: —');

  await rowA.click();
  await expect(page.getByRole('heading', { name: 'Padaria Aurora', level: 1 })).toBeVisible();
  await expect(page.locator('main p', { hasText: 'Dono:' })).toHaveText('Dono: l***@exemplo.test');
  await expect(page.getByText('Empresa sem dono ativo', { exact: false })).toHaveCount(0);
  const people = page.getByRole('list', { name: 'Pessoas da empresa' });
  await expect(people.getByRole('listitem')).toHaveCount(3);
  await expect(people.getByRole('listitem').first()).toContainText('l***@exemplo.test');
  await expect(people.getByRole('listitem').first()).toContainText('Dono');
  await expect(people.getByRole('listitem').nth(1)).toContainText('Conta desativada');
  await expect(people.getByRole('listitem').nth(1)).toContainText('E-mail não confirmado');
  await expect(people.getByRole('listitem').nth(2)).toContainText('Sem conta (vínculo antigo)');
  // Vínculo antigo sem conta: sem "Abrir conta".
  await expect(people.getByRole('button', { name: /^Abrir conta/ })).toHaveCount(2);
  await expect(page.getByText('Convites pendentes')).toBeVisible();

  await people.getByRole('button', { name: 'Abrir conta l***@exemplo.test' }).click();
  await expect(page.getByRole('heading', { name: 'Conta', level: 1 })).toBeVisible();
  await expect(page.getByText(FULL_EMAIL)).toHaveCount(0);
  await expect
    .poll(() => api.callsTo('GET', `/platform/accounts/${ACCOUNT_A}`).length)
    .toBeGreaterThan(0);
  expect(api.callsTo('GET', `/platform/accounts/${ACCOUNT_A}/email`)).toHaveLength(0);
  expect(await hasHorizontalScroll(page), 'detalhe da conta').toBe(false);

  // Voltar leva de novo à empresa.
  await page.getByRole('button', { name: 'Voltar' }).click();
  await expect(page.getByRole('heading', { name: 'Padaria Aurora', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Voltar' }).click();
  await expect(page.getByRole('heading', { name: 'Empresas', level: 1 })).toBeVisible();

  // Empresa sem dono ativo: o aviso aparece (a cobrança desligada não esconde as pessoas).
  await page.getByRole('button', { name: 'Abrir Oficina Boa Vista' }).click();
  await expect(page.getByText('Empresa sem dono ativo.', { exact: false })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Pessoas da empresa' })).toContainText(
    'o***@exemplo.test',
  );
  expect(await hasHorizontalScroll(page), 'empresa sem dono').toBe(false);
  expect(api.calls.some((call) => call.path.endsWith('/email'))).toBe(false);
  expect(await storageSizes(page)).toEqual([0, 0]);
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
  const api = await openHealthWithFrozenClock(page, { queueUnavailable: true });
  await expect(page.getByText('Indisponível')).toBeVisible();
  await expect(page.getByText('Envios pelo canal: ok')).toBeVisible();
  // Em desenvolvimento o StrictMode do React monta a tela duas vezes; conta-se a partir daqui.
  const reads = () => api.callsTo('GET', '/platform/health').length;
  const first = reads();

  // Relógio parado desde antes de a tela montar: o intervalo começa num instante conhecido.
  await page.clock.runFor(59_000);
  expect(reads()).toBe(first);
  await page.clock.runFor(1_000);
  await expect.poll(reads).toBe(first + 1);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  });
  await page.clock.runFor(180_000);
  expect(reads()).toBe(first + 1);
});

test('Saúde: 30 min sem tecla nem ponteiro pausam a releitura automática até "Retomar"', async ({
  page,
}) => {
  const api = await openHealthWithFrozenClock(page);
  await expect(page.getByText('Envios pelo canal: ok')).toBeVisible();
  const reads = () => api.callsTo('GET', '/platform/health').length;
  const paused = page.getByText('Atualização automática pausada');
  const first = reads();

  // Uma tecla aos 20 min renova o prazo: aos 40 min (20 desde a tecla) ainda relê.
  await page.clock.runFor(20 * 60_000);
  await expect.poll(reads).toBe(first + 20);
  await page.keyboard.press('Shift');
  await page.clock.runFor(20 * 60_000);
  await expect.poll(reads).toBe(first + 40);
  await expect(paused).toHaveCount(0);

  // Aos 30 min desde a tecla, pausa: nenhuma releitura a mais, por mais tempo que passe.
  await page.clock.runFor(10 * 60_000);
  await expect(paused).toBeVisible();
  const atPause = reads();
  expect(atPause).toBe(first + 49);
  await page.clock.runFor(30 * 60_000);
  expect(reads()).toBe(atPause);

  await page.getByRole('button', { name: 'Retomar' }).click();
  await expect(paused).toHaveCount(0);
  await expect.poll(reads).toBe(atPause + 1);
  await page.clock.runFor(60_000);
  await expect.poll(reads).toBe(atPause + 2);
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
