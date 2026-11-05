import { expect, test, type Page } from '@playwright/test';
import { company, conversation, installApi, openMenu } from './company-fixture';

// Spec 029 (E2): a pessoa entra com a empresa já aberta. O servidor pré-seleciona a última usada no login
// (a API falsa devolve `selectedCompanyId` já escolhido); o site só abre, ou cai no fallback.

async function switcherText(page: Page): Promise<string> {
  await openMenu(page);
  return (await page.getByRole('button', { name: /Trocar de empresa/ }).textContent()) ?? '';
}

test('uma empresa e sessão sem seleção: o site seleciona e abre direto em Conversas', async ({
  page,
}) => {
  const only = company('Empresa Única');
  const api = await installApi(page, { companies: [only], selected: null });
  api.conversations = [conversation('Contato final 1234', 'whatsapp', 1)];
  await page.goto('/entrar');
  await expect(page).toHaveURL(/\/painel\/conversas$/);
  await expect(page.getByRole('link', { name: /Contato final 1234/ })).toBeVisible();
  await expect(page.getByText('Suas empresas')).toHaveCount(0);
  expect(await switcherText(page)).toContain('Empresa Única');
  expect(
    api.calls.filter((call) => call.path === `/account/companies/${only.companyId}/select`),
  ).toHaveLength(1);
});

test('várias empresas com uma já selecionada pelo servidor (a última usada): abre essa', async ({
  page,
}) => {
  const first = company('Empresa A');
  const second = company('Empresa B');
  const api = await installApi(page, { companies: [first, second], selected: second.companyId });
  await page.goto('/entrar');
  await expect(page).toHaveURL(/\/painel\/conversas$/);
  expect(await switcherText(page)).toContain('Empresa B');
  // Nenhuma seleção extra do site: o servidor já tinha escolhido.
  expect(api.calls.filter((call) => call.path.endsWith('/select'))).toHaveLength(0);
});

test('várias empresas e nenhuma selecionada: mostra a tela de empresas', async ({ page }) => {
  const api = await installApi(page, {
    companies: [company('Empresa A'), company('Empresa B')],
    selected: null,
  });
  await page.goto('/entrar');
  await expect(page.getByText('Suas empresas')).toBeVisible();
  await expect(page).toHaveURL(/\/painel\/empresas$/);
  expect(api.calls.filter((call) => call.path.endsWith('/select'))).toHaveLength(0);
});

test('nenhuma empresa: criação da primeira', async ({ page }) => {
  await installApi(page, { companies: [], selected: null });
  await page.goto('/entrar');
  await expect(page.getByText('Você ainda não tem empresas.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Nome da empresa')).toBeVisible();
});

test('recarregar a página dentro do painel mantém a empresa; a tela de empresas não pula sozinha', async ({
  page,
}) => {
  const first = company('Empresa A');
  const second = company('Empresa B');
  const api = await installApi(page, { companies: [first, second], selected: first.companyId });
  api.conversations = [conversation('Contato final 1111', 'whatsapp', 1)];
  await page.goto('/painel/conversas');
  await expect(page.getByRole('link', { name: /Contato final 1111/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: /Contato final 1111/ })).toBeVisible();
  // Gerenciar empresas continua abrindo a tela de escolher e criar, mesmo depois de recarregar.
  await openMenu(page);
  await page.getByRole('button', { name: /Trocar de empresa/ }).click();
  await page.getByRole('menuitem', { name: 'Gerenciar empresas' }).click();
  await expect(page.getByText('Suas empresas')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Suas empresas')).toBeVisible();
  await expect(page).toHaveURL(/\/painel\/empresas$/);
});

test('o site não guarda a última empresa: só o tema no armazenamento', async ({ page }) => {
  const first = company('Empresa A');
  const second = company('Empresa B');
  await installApi(page, { companies: [first, second], selected: first.companyId });
  await page.goto('/entrar');
  await expect(page).toHaveURL(/\/painel\/conversas$/);
  await openMenu(page);
  await page.getByRole('button', { name: /Trocar de empresa/ }).click();
  await page.getByRole('menuitemradio', { name: /Empresa B/ }).click();
  await expect(page).toHaveURL(/\/painel\/conversas$/);
  const stored = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    href: location.href,
  }));
  expect(stored.local.filter((key) => key !== 'soprei-theme')).toEqual([]);
  expect(stored.session).toEqual([]);
  expect(stored.href).not.toContain(second.companyId);
});
