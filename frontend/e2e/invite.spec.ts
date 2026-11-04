import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { company, installApi, SENTINEL, type Call, type FakeApi } from './company-fixture';

const FAILURE = 'Este convite é inválido, venceu ou foi enviado para outro e-mail.';
const COMPANY_NAME = 'Padaria do Convite';
const INVITED_EMAIL = 'convidada@example.test';
const SESSION_EMAIL = 'pessoa@example.test';

const newToken = (): string => `${randomUUID()}.${randomUUID()}.${'B'.repeat(43)}`;

interface FakeInvite {
  loggedIn: boolean;
  sessionEmail: string;
  preview:
    | { companyName: string; role: string; email: string; accountState: 'NEW' | 'EXISTS' }
    | { status: number; code: string };
  acceptError: { status: number; code: string } | null;
  acceptNewError: { status: number; code: string } | null;
  calls: Call[];
}

/**
 * Camada por cima da API falsa base: sessão com e sem login, o login, o aceite e as três rotas públicas
 * do convite. Registrada depois de `installApi` (o último handler vale primeiro; `fallback` entrega o resto).
 */
async function install(
  page: Page,
  overrides: Partial<FakeInvite> = {},
): Promise<{ api: FakeApi; invite: FakeInvite }> {
  await page.addInitScript(() => localStorage.setItem('soprei-theme', 'light'));
  const api = await installApi(page);
  const invite: FakeInvite = {
    loggedIn: true,
    sessionEmail: SESSION_EMAIL,
    preview: {
      companyName: COMPANY_NAME,
      role: 'AGENT',
      email: SESSION_EMAIL,
      accountState: 'EXISTS',
    },
    acceptError: null,
    acceptNewError: null,
    calls: [],
    ...overrides,
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api', '');
    const method = request.method();
    const body: unknown = method === 'GET' ? undefined : request.postDataJSON();
    const reply = (status: number, json?: unknown) =>
      route.fulfill({ status, ...(json === undefined ? {} : { json }) });
    const fail = (status: number, code: string) =>
      reply(status, { error: { code, message: SENTINEL, requestId: 'x' } });

    if (path === '/auth/session') {
      if (!invite.loggedIn) return fail(401, 'UNAUTHORIZED');
      return reply(200, {
        id: randomUUID(),
        email: invite.sessionEmail,
        selectedCompanyId: api.selected,
      });
    }
    if (path === '/account/companies' && method === 'GET') {
      return invite.loggedIn ? route.fallback() : fail(401, 'UNAUTHORIZED');
    }
    if (path === '/auth/login') {
      invite.calls.push({ method, path, body });
      invite.loggedIn = true;
      return reply(204);
    }
    if (path === '/auth/logout') {
      invite.loggedIn = false;
      return reply(204);
    }
    if (!path.startsWith('/auth/invitations/')) return route.fallback();

    invite.calls.push({ method, path, body });
    if (path.endsWith('/preview')) {
      return 'status' in invite.preview
        ? fail(invite.preview.status, invite.preview.code)
        : reply(200, invite.preview);
    }
    if (path.endsWith('/accept')) {
      if (!invite.loggedIn) return fail(401, 'UNAUTHORIZED');
      if (invite.acceptError) return fail(invite.acceptError.status, invite.acceptError.code);
      const joined = company(COMPANY_NAME, 'AGENT');
      api.companies.push(joined);
      api.selected = joined.companyId;
      return reply(204);
    }
    if (invite.acceptNewError)
      return fail(invite.acceptNewError.status, invite.acceptNewError.code);
    return reply(204);
  });
  return { api, invite };
}

const inviteCalls = (invite: FakeInvite) =>
  invite.calls.filter((call) => call.path.startsWith('/auth/invitations/'));

async function expectNothingStored(page: Page, token: string, extra: string[] = []): Promise<void> {
  const stored = await page.evaluate(() => ({
    keys: [...Object.keys(localStorage), ...Object.keys(sessionStorage)],
    values: [...Object.values(localStorage), ...Object.values(sessionStorage)].join('|'),
    href: location.href,
    hash: location.hash,
    title: document.title,
  }));
  expect(stored.keys.filter((key) => key !== 'soprei-theme')).toEqual([]);
  expect(stored.hash).toBe('');
  for (const secret of [token, token.split('.')[2] ?? '', INVITED_EMAIL, COMPANY_NAME, ...extra]) {
    expect(stored.values).not.toContain(secret);
    expect(stored.href).not.toContain(secret);
    expect(stored.title).not.toContain(secret);
  }
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test('caso (a): logada com o mesmo e-mail aceita e cai em Conversas da empresa nova; o fragmento sai da barra', async ({
  page,
}) => {
  const token = newToken();
  const { api, invite } = await install(page);
  await page.goto(`/convite#t=${token}`);
  await expect(page.getByText('Você foi convidado para a empresa')).toContainText(COMPANY_NAME);
  await expect(page.getByText('Você está entrando como')).toContainText(SESSION_EMAIL);
  // Depois do carregamento o token já saiu da barra e de todo armazenamento.
  expect(page.url()).not.toContain('#');
  await expectNothingStored(page, token, [SESSION_EMAIL]);
  await noHorizontalScroll(page);

  await page.getByRole('button', { name: `Entrar na empresa ${COMPANY_NAME}` }).click();
  await expect(page).toHaveURL(/\/painel\/conversas$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(COMPANY_NAME);
  expect(inviteCalls(invite).map((call) => `${call.method} ${call.path}`)).toEqual(
    expect.arrayContaining(['POST /auth/invitations/preview', 'POST /auth/invitations/accept']),
  );
  const accept = inviteCalls(invite).find((call) => call.path.endsWith('/accept'));
  expect(accept?.body).toEqual({ token });
  await expectNothingStored(page, token, [SESSION_EMAIL]);
  expect(api.external.filter((url) => !url.includes('fonts.g'))).toEqual([]);
});

test('caso (b): sem sessão vai ao login e volta ao convite sem perder o token em memória, e aceita', async ({
  page,
}) => {
  const token = newToken();
  const { invite } = await install(page, { loggedIn: false });
  await page.goto(`/convite#t=${token}`);
  await expect(page.getByText('Você foi convidado para a empresa')).toBeVisible();
  await page.getByRole('button', { name: 'Entrar para aceitar' }).click();
  await expect(page).toHaveURL(/\/entrar$/);
  await expectNothingStored(page, token);

  await page.getByLabel('E-mail').fill(SESSION_EMAIL);
  await page.getByLabel('Senha', { exact: true }).fill('Secret1-forte');
  await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  // Depois do login a pessoa volta ao convite (token só em memória).
  await expect(page).toHaveURL(/\/convite$/);
  await expect(page.getByText('Você foi convidado para a empresa')).toBeVisible();
  await page.getByRole('button', { name: `Entrar na empresa ${COMPANY_NAME}` }).click();
  await expect(page).toHaveURL(/\/painel\/conversas$/);
  const previews = inviteCalls(invite).filter((call) => call.path.endsWith('/preview'));
  expect(previews.length).toBeGreaterThanOrEqual(2);
  for (const call of previews) expect(call.body).toEqual({ token });
  expect(inviteCalls(invite).find((call) => call.path.endsWith('/accept'))?.body).toEqual({
    token,
  });
  await expectNothingStored(page, token);
});

test('caso (c): sem conta define a senha (dica e erro acessíveis), vê "Conta criada" e cai em /entrar com o e-mail do convite', async ({
  page,
}) => {
  const token = newToken();
  const { invite } = await install(page, {
    loggedIn: false,
    preview: {
      companyName: COMPANY_NAME,
      role: 'VIEWER',
      email: INVITED_EMAIL,
      accountState: 'NEW',
    },
  });
  await page.goto(`/convite#t=${token}`);
  await expect(page.getByText('Somente leitura')).toBeVisible();
  await expect(
    page.getByText('Mínimo de 6 caracteres, com uma letra maiúscula e um número.'),
  ).toBeVisible();
  await noHorizontalScroll(page);

  const password = page.getByLabel('Senha', { exact: true });
  const confirmation = page.getByLabel('Confirmar senha');
  await password.fill('fraca');
  await confirmation.fill('fraca');
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(
    page.getByText('Use pelo menos 6 caracteres, incluindo uma letra maiúscula e um número.'),
  ).toBeVisible();
  expect(inviteCalls(invite).some((call) => call.path.endsWith('/accept-new'))).toBe(false);

  await password.fill('Forte1senha');
  await confirmation.fill('Outra1senha');
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page.getByText('As senhas não coincidem. Confira e tente novamente.')).toBeVisible();

  await confirmation.fill('Forte1senha');
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/entrar$/);
  await expect(page.getByText('Conta criada. Entre com a senha que você definiu.')).toBeVisible();
  await expect(page.getByLabel('E-mail')).toHaveValue(INVITED_EMAIL);
  await expect(page.getByLabel('Senha', { exact: true })).toHaveValue('');
  const created = inviteCalls(invite).find((call) => call.path.endsWith('/accept-new'));
  expect(created?.body).toEqual({ token, password: 'Forte1senha' });
  // Sem login automático: nenhuma chamada de login foi feita.
  expect(invite.calls.some((call) => call.path === '/auth/login')).toBe(false);
  await expectNothingStored(page, token);
});

test('conta logada com e-mail diferente: mensagem sem dizer qual e-mail, "Sair e entrar com outra conta" e volta ao convite', async ({
  page,
}) => {
  const token = newToken();
  await install(page, {
    sessionEmail: 'outra@example.test',
    preview: {
      companyName: COMPANY_NAME,
      role: 'AGENT',
      email: INVITED_EMAIL,
      accountState: 'EXISTS',
    },
  });
  await page.goto(`/convite#t=${token}`);
  await expect(page.getByText('Este convite foi enviado para outro e-mail.')).toBeVisible();
  await expect(page.getByText('Você está entrando como')).toContainText('outra@example.test');
  // O e-mail do convite nunca aparece na tela de quem tem outra conta.
  await expect(page.getByText(INVITED_EMAIL)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Entrar na empresa/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sair e entrar com outra conta' }).click();
  await expect(page).toHaveURL(/\/entrar$/);
  await page.getByLabel('E-mail').fill(INVITED_EMAIL);
  await page.getByLabel('Senha', { exact: true }).fill('Secret1-forte');
  await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await expect(page).toHaveURL(/\/convite$/);
  await expect(page.getByText('Você foi convidado para a empresa')).toBeVisible();
});

test('convite inválido, vencido ou revogado: a mesma mensagem única, sem texto do servidor', async ({
  page,
}) => {
  const token = newToken();
  await install(page, { preview: { status: 400, code: 'INVITATION_INVALID' } });
  await page.goto(`/convite#t=${token}`);
  await expect(page.getByRole('alert')).toContainText(FAILURE);
  await expect(page.getByText(SENTINEL)).toHaveCount(0);
  await page.getByRole('button', { name: 'Ir para a entrada' }).click();
  await expect(page).toHaveURL(/\/entrar$/);
});

test('a falha do aceite (400 uniforme) vira a mesma mensagem e 503 é "tente de novo"', async ({
  page,
}) => {
  const token = newToken();
  const { invite } = await install(page, {
    acceptError: { status: 400, code: 'INVITATION_INVALID' },
  });
  await page.goto(`/convite#t=${token}`);
  await page.getByRole('button', { name: `Entrar na empresa ${COMPANY_NAME}` }).click();
  await expect(page.getByRole('alert')).toContainText(FAILURE);
  await expect(page.getByText(SENTINEL)).toHaveCount(0);
  expect(inviteCalls(invite).length).toBeGreaterThanOrEqual(2);
});

test('falha de servidor no preview oferece "Tentar de novo" e depois abre o convite', async ({
  page,
}) => {
  const token = newToken();
  const { invite } = await install(page, { preview: { status: 503, code: 'SERVICE_UNAVAILABLE' } });
  await page.goto(`/convite#t=${token}`);
  await expect(page.getByRole('alert')).toContainText(
    'Não foi possível verificar o convite agora.',
  );
  invite.preview = {
    companyName: COMPANY_NAME,
    role: 'AGENT',
    email: SESSION_EMAIL,
    accountState: 'EXISTS',
  };
  await page.getByRole('button', { name: 'Tentar de novo' }).click();
  await expect(page.getByText('Você foi convidado para a empresa')).toBeVisible();
});

for (const hash of [
  '',
  '#',
  '#t=',
  '#t=lixo',
  `#t=${'a'.repeat(300)}`,
  `#x=11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222.${'B'.repeat(43)}`,
]) {
  test(`fragmento ausente ou malformado (${hash.slice(0, 12) || 'vazio'}): a mesma tela de falha, sem chamar a API`, async ({
    page,
  }) => {
    const { invite } = await install(page);
    await page.goto(`/convite${hash}`);
    await expect(page.getByRole('alert')).toContainText(FAILURE);
    expect(inviteCalls(invite)).toEqual([]);
    expect(page.url()).not.toContain('#');
    await noHorizontalScroll(page);
  });
}

test('a tela de convite aguenta o tema escuro e a largura de 360 px', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const token = newToken();
  await install(page, {
    loggedIn: false,
    preview: {
      companyName: COMPANY_NAME,
      role: 'ADMIN',
      email: INVITED_EMAIL,
      accountState: 'NEW',
    },
  });
  await page.addInitScript(() => localStorage.setItem('soprei-theme', 'dark'));
  await page.goto(`/convite#t=${token}`);
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({ path: testInfo.outputPath('convite-escuro.png'), fullPage: true });
});
