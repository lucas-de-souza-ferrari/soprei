import { test, expect, type Page } from '@playwright/test';
import { COMPANY_A, MEMBER_EMAIL, pendingInvitation } from './fixtures';
import { hasHorizontalScroll, installFakeApi, storageSizes } from './fake-api';

// Spec 045, E3b: convites da plataforma (convidar, reenviar, revogar) e "Nova empresa", contra a API falsa.

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name, exact: true });

async function openCompanyA(page: Page): Promise<void> {
  await nav(page, 'Empresas').click();
  await page.getByRole('button', { name: 'Abrir Padaria Aurora' }).click();
  await expect(page.getByRole('heading', { name: 'Padaria Aurora', level: 1 })).toBeVisible();
}

test('convites: a lista mascarada, convidar como dono, reenviar e revogar; o e-mail digitado não fica na tela', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await openCompanyA(page);
  const base = `/platform/companies/${COMPANY_A}/invitations`;
  const list = page.getByRole('list', { name: 'Convites pendentes' });
  await expect(list.getByText(pendingInvitation.emailMasked)).toBeVisible();
  await expect(list.getByText('Pela equipe')).toBeVisible();

  await page.getByRole('button', { name: 'Convidar pessoa' }).click();
  const invite = page.getByRole('dialog', { name: 'Convidar pessoa para Padaria Aurora?' });
  const send = invite.getByRole('button', { name: 'Enviar convite' });
  await expect(send).toBeDisabled();
  await invite.getByLabel('E-mail da pessoa').fill('nova.dona@exemplo.test');
  await invite.getByLabel('Papel').selectOption('OWNER');
  await expect(invite.getByLabel('Código novo do autenticador')).toHaveCount(0);
  await send.click();
  await expect(invite).toBeHidden();
  await expect(list.getByText('n***@exemplo.test')).toBeVisible();
  await expect(list.getByText('Pela plataforma')).toBeVisible();
  expect(api.callsTo('POST', base).map((call) => call.body)).toEqual([
    { email: 'nova.dona@exemplo.test', role: 'OWNER', reason: 'OWNER_REQUEST' },
  ]);
  await expect(page.getByText('nova.dona@exemplo.test')).toHaveCount(0);

  await page
    .getByRole('button', { name: `Reenviar convite ${pendingInvitation.emailMasked}` })
    .click();
  await page
    .getByRole('dialog', { name: `Reenviar o convite para ${pendingInvitation.emailMasked}?` })
    .getByRole('button', { name: 'Reenviar' })
    .click();
  await expect(list.getByText('2 envios')).toBeVisible();

  await page
    .getByRole('button', { name: `Revogar convite ${pendingInvitation.emailMasked}` })
    .click();
  const revoke = page.getByRole('dialog', {
    name: `Revogar o convite para ${pendingInvitation.emailMasked}?`,
  });
  await revoke.getByLabel('Motivo').selectOption({ label: 'Abuso' });
  await revoke.getByRole('button', { name: 'Revogar convite' }).click();
  await expect(list.getByText(pendingInvitation.emailMasked)).toHaveCount(0);
  expect(
    api.callsTo('POST', `${base}/${pendingInvitation.id}/revoke`).map((call) => call.body),
  ).toEqual([{ reason: 'ABUSE' }]);
  expect(await hasHorizontalScroll(page)).toBe(false);
  expect(await storageSizes(page)).toEqual([0, 0]);
});

test('convites: pessoa que já é da empresa mostra a recusa própria (409 MEMBER_ALREADY_EXISTS)', async ({
  page,
}) => {
  await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await openCompanyA(page);
  await page.getByRole('button', { name: 'Convidar pessoa' }).click();
  const invite = page.getByRole('dialog', { name: 'Convidar pessoa para Padaria Aurora?' });
  await invite.getByLabel('E-mail da pessoa').fill(MEMBER_EMAIL);
  await invite.getByRole('button', { name: 'Enviar convite' }).click();
  await expect(invite.getByRole('alert')).toContainText('Esta pessoa já faz parte da empresa.');
});

test('"Nova empresa": nome, slug e e-mail do dono; slug repetido mostra a recusa; criada, abre o detalhe', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await nav(page, 'Empresas').click();
  await page.getByRole('button', { name: 'Nova empresa' }).click();
  const dialog = page.getByRole('dialog', { name: 'Criar empresa?' });
  const create = dialog.getByRole('button', { name: 'Criar empresa' });
  await expect(create).toBeDisabled();
  await dialog.getByLabel('Nome').fill('Oficina Nova');
  await dialog.getByLabel('Slug').fill('Padaria-Aurora');
  await expect(dialog.getByLabel('Slug')).toHaveValue('padaria-aurora');
  await dialog.getByLabel('E-mail de quem será o dono').fill('dono.novo@exemplo.test');
  await create.click();
  await expect(dialog.getByRole('alert')).toContainText('Já existe uma empresa com este slug');
  await dialog.getByLabel('Slug').fill('oficina-nova');
  await create.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Oficina Boa Vista', level: 1 })).toBeVisible();
  expect(api.callsTo('POST', '/platform/companies').map((call) => call.body)).toEqual([
    {
      name: 'Oficina Nova',
      slug: 'padaria-aurora',
      ownerEmail: 'dono.novo@exemplo.test',
      reason: 'OWNER_REQUEST',
    },
    {
      name: 'Oficina Nova',
      slug: 'oficina-nova',
      ownerEmail: 'dono.novo@exemplo.test',
      reason: 'OWNER_REQUEST',
    },
  ]);
  await expect(page.getByText('dono.novo@exemplo.test')).toHaveCount(0);
  expect(await hasHorizontalScroll(page)).toBe(false);
  expect(await storageSizes(page)).toEqual([0, 0]);
});
