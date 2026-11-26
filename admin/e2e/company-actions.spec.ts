import { test, expect, type Page } from '@playwright/test';
import { COMPANY_A, MEMBERSHIP_LEGACY } from './fixtures';
import { FRESH_CODE, GOOD, hasHorizontalScroll, installFakeApi, storageSizes } from './fake-api';

// Spec 045, E3a: ações do admin sobre a empresa (renomear, remover, restaurar) e sobre as pessoas dela
// (mudar papel, desativar e reativar o vínculo), contra a API falsa.

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name, exact: true });

async function openCompanyA(page: Page): Promise<void> {
  await nav(page, 'Empresas').click();
  await page.getByRole('button', { name: 'Abrir Padaria Aurora' }).click();
  await expect(page.getByRole('heading', { name: 'Padaria Aurora', level: 1 })).toBeVisible();
}

test('empresa: renomear pede o nome e o motivo; remover exige o slug digitado e o código novo; restaurar pela lista de removidas', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await openCompanyA(page);
  const base = `/platform/companies/${COMPANY_A}`;

  await page.getByRole('button', { name: 'Renomear', exact: true }).click();
  const rename = page.getByRole('dialog', { name: 'Renomear a empresa?' });
  const name = rename.getByLabel('Nome novo');
  await expect(name).toHaveValue('Padaria Aurora');
  await name.fill('Padaria Aurora Nova');
  await rename.getByRole('button', { name: 'Renomear' }).click();
  await expect(rename).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Padaria Aurora Nova', level: 1 })).toBeVisible();
  expect(api.callsTo('POST', `${base}/rename`).map((call) => call.body)).toEqual([
    { name: 'Padaria Aurora Nova', reason: 'OWNER_REQUEST' },
  ]);

  await page.getByRole('button', { name: 'Remover empresa' }).click();
  const remove = page.getByRole('dialog', { name: 'Remover Padaria Aurora Nova?' });
  await expect(remove.getByText('o número do WhatsApp é liberado', { exact: false })).toBeVisible();
  const confirm = remove.getByRole('button', { name: 'Confirmar remoção' });
  await expect(confirm).toBeDisabled();
  await remove.getByLabel('Digite o slug da empresa (padaria-aurora)').fill('padaria-aurora');
  // Slug certo, mas sem o código: o botão continua desligado.
  await expect(confirm).toBeDisabled();
  await remove.getByLabel('Motivo').selectOption({ label: 'Abuso' });
  const code = remove.getByLabel('Código novo do autenticador');
  await code.fill(GOOD.code);
  await confirm.click();
  await expect(remove.getByRole('alert')).toContainText(
    'Código do autenticador inválido ou já usado',
  );
  await expect(code).toHaveValue('');
  expect(await hasHorizontalScroll(page)).toBe(false);
  await code.fill(FRESH_CODE);
  await confirm.click();
  await expect(remove).toBeHidden();
  await expect(page.getByText('Empresa removida em', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suspender', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remover empresa' })).toHaveCount(0);
  // Empresa removida: as pessoas só são vistas.
  await expect(page.getByRole('button', { name: /^Mudar papel/ })).toHaveCount(0);
  expect(api.callsTo('POST', `${base}/remove`).map((call) => call.body)).toEqual([
    { slug: 'padaria-aurora', reason: 'ABUSE', code: GOOD.code },
    { slug: 'padaria-aurora', reason: 'ABUSE', code: FRESH_CODE },
  ]);

  // A lista de removidas a mostra; dali se restaura.
  await nav(page, 'Empresas').click();
  await expect(page.getByRole('button', { name: 'Abrir Padaria Aurora Nova' })).toHaveCount(0);
  await page.getByLabel('Estado').selectOption({ label: 'Removidas' });
  await expect(page.getByText('Removida', { exact: true })).toBeVisible();
  expect(api.calls.at(-1)?.search.get('status')).toBe('removed');
  await page.getByRole('button', { name: 'Abrir Padaria Aurora Nova' }).click();
  await page.getByRole('button', { name: 'Restaurar', exact: true }).click();
  const restore = page.getByRole('dialog', { name: 'Restaurar Padaria Aurora Nova?' });
  await expect(restore.getByText('O canal não volta', { exact: false })).toBeVisible();
  await restore.getByLabel('Código novo do autenticador').fill(FRESH_CODE);
  await restore.getByRole('button', { name: 'Confirmar restauração' }).click();
  await expect(restore).toBeHidden();
  await expect(page.getByRole('button', { name: 'Remover empresa' })).toBeVisible();
  expect(api.callsTo('POST', `${base}/restore`).map((call) => call.body)).toEqual([
    { reason: 'OWNER_REQUEST', code: FRESH_CODE },
  ]);
  // O código não fica na tela (os ids do canal da fixtura contêm os mesmos dígitos: só o texto exato conta).
  await expect(page.getByText(FRESH_CODE, { exact: true })).toHaveCount(0);
  expect(await storageSizes(page)).toEqual([0, 0]);
});

test('empresa: uma recusa do servidor na remoção aparece no diálogo e nada muda', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  api.failures.set(`/platform/companies/${COMPANY_A}/remove`, 429);
  await page.goto('/');
  await openCompanyA(page);
  await page.getByRole('button', { name: 'Remover empresa' }).click();
  const remove = page.getByRole('dialog', { name: 'Remover Padaria Aurora?' });
  await remove.getByLabel('Digite o slug da empresa (padaria-aurora)').fill('padaria-aurora');
  await remove.getByLabel('Código novo do autenticador').fill(FRESH_CODE);
  await remove.getByRole('button', { name: 'Confirmar remoção' }).click();
  await expect(remove.getByRole('alert')).toContainText('Muitas tentativas');
  await expect(remove).toBeVisible();
  expect(api.companyRemovedAt).toBeNull();
});

test('pessoas: mudar papel pede código só quando envolve o dono; rebaixar o último dono mostra a recusa; desativar e reativar o vínculo', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await openCompanyA(page);
  const base = `/platform/companies/${COMPANY_A}/memberships`;

  // Vínculo antigo (atendente): mudar para administrador não pede código.
  await page.getByRole('button', { name: 'Mudar papel v***@exemplo.test' }).click();
  const legacy = page.getByRole('dialog', { name: 'Mudar o papel de v***@exemplo.test?' });
  const change = legacy.getByRole('button', { name: 'Mudar papel' });
  await expect(change).toBeDisabled();
  await expect(legacy.getByLabel('Código novo do autenticador')).toHaveCount(0);
  await legacy.getByLabel('Papel novo').selectOption('ADMIN');
  await change.click();
  await expect(legacy).toBeHidden();
  expect(api.callsTo('POST', `${base}/${MEMBERSHIP_LEGACY}/role`).map((call) => call.body)).toEqual(
    [{ role: 'ADMIN', reason: 'OWNER_REQUEST' }],
  );

  // O dono: rebaixar pede o código e, sendo o único dono ativo, o servidor recusa.
  await page.getByRole('button', { name: 'Mudar papel l***@exemplo.test' }).click();
  const owner = page.getByRole('dialog', { name: 'Mudar o papel de l***@exemplo.test?' });
  await owner.getByLabel('Papel novo').selectOption('ADMIN');
  await owner.getByLabel('Código novo do autenticador').fill(FRESH_CODE);
  await owner.getByRole('button', { name: 'Mudar papel' }).click();
  await expect(owner.getByRole('alert')).toContainText('A empresa ficaria sem dono ativo');
  await owner.getByRole('button', { name: 'Cancelar' }).click();
  await expect(owner).toBeHidden();

  // Remover da empresa = desativar o vínculo; depois reativar.
  await page.getByRole('button', { name: 'Desativar v***@exemplo.test' }).click();
  const disable = page.getByRole('dialog', { name: 'Remover v***@exemplo.test da empresa?' });
  await disable.getByLabel('Motivo').selectOption({ label: 'Abuso' });
  await disable.getByRole('button', { name: 'Desativar vínculo' }).click();
  await expect(disable).toBeHidden();
  await page.getByRole('button', { name: 'Reativar v***@exemplo.test' }).click();
  await page
    .getByRole('dialog', { name: 'Reativar v***@exemplo.test?' })
    .getByRole('button', { name: 'Reativar vínculo' })
    .click();
  await expect(page.getByRole('button', { name: 'Desativar v***@exemplo.test' })).toBeVisible();
  expect(api.callsTo('POST', `${base}/${MEMBERSHIP_LEGACY}/disable`).map((c) => c.body)).toEqual([
    { reason: 'ABUSE' },
  ]);
  expect(api.callsTo('POST', `${base}/${MEMBERSHIP_LEGACY}/enable`).map((c) => c.body)).toEqual([
    { reason: 'OWNER_REQUEST' },
  ]);
  expect(await hasHorizontalScroll(page)).toBe(false);
  expect(await storageSizes(page)).toEqual([0, 0]);
});

test('pessoas: 503 ao mudar papel relê a tela e diz que a ação pode ter sido registrada; 401 volta a Entrar', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  api.revocationDown = true;
  await page.goto('/');
  await openCompanyA(page);
  await page.getByRole('button', { name: 'Mudar papel v***@exemplo.test' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mudar o papel de v***@exemplo.test?' });
  await dialog.getByLabel('Papel novo').selectOption('VIEWER');
  await dialog.getByRole('button', { name: 'Mudar papel' }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'A ação pode ter sido registrada sem que as sessões tenham sido encerradas',
  );
  await expect
    .poll(() => api.callsTo('GET', `/platform/companies/${COMPANY_A}`).length)
    .toBeGreaterThanOrEqual(2);

  api.revocationDown = false;
  api.expired.add(`/platform/companies/${COMPANY_A}/memberships/${MEMBERSHIP_LEGACY}/disable`);
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await page.getByRole('button', { name: 'Desativar v***@exemplo.test' }).click();
  await page
    .getByRole('dialog', { name: 'Remover v***@exemplo.test da empresa?' })
    .getByRole('button', { name: 'Desativar vínculo' })
    .click();
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  expect(await storageSizes(page)).toEqual([0, 0]);
});

test('canal: "Desconectar WhatsApp" avisa da WABA inteira, pede o código novo e, desconectado, o botão some (spec 045, E5)', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await openCompanyA(page);
  await page.getByRole('button', { name: 'Desconectar WhatsApp' }).click();
  const dialog = page.getByRole('dialog', { name: 'Desconectar o WhatsApp de Padaria Aurora?' });
  await expect(dialog.getByText('desassinado da WABA inteira', { exact: false })).toBeVisible();
  const code = dialog.getByLabel('Código novo do autenticador');
  await code.fill(GOOD.code);
  await dialog.getByRole('button', { name: 'Desconectar' }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Código do autenticador inválido ou já usado',
  );
  await code.fill(FRESH_CODE);
  await dialog.getByRole('button', { name: 'Desconectar' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Não conectado.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Desconectar WhatsApp' })).toHaveCount(0);
  expect(
    api.callsTo('POST', `/platform/companies/${COMPANY_A}/channel/disconnect`).map((c) => c.body),
  ).toEqual([
    { reason: 'OWNER_REQUEST', code: GOOD.code },
    { reason: 'OWNER_REQUEST', code: FRESH_CODE },
  ]);
  expect(await storageSizes(page)).toEqual([0, 0]);
});

test('canal LEGACY: "Liberar número" com título e efeito próprios; canal desligado no servidor mostra a recusa própria', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  api.channelLegacy = true;
  api.channelOff = true;
  await page.goto('/');
  await openCompanyA(page);
  await expect(page.getByRole('button', { name: 'Desconectar WhatsApp' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Liberar número' }).click();
  const dialog = page.getByRole('dialog', { name: 'Liberar o número de Padaria Aurora?' });
  await expect(dialog.getByText('fica livre para ser conectado', { exact: false })).toBeVisible();
  await dialog.getByLabel('Código novo do autenticador').fill(FRESH_CODE);
  await dialog.getByRole('button', { name: 'Liberar número' }).click();
  await expect(dialog.getByRole('alert')).toContainText('O canal do WhatsApp está desligado');
  api.channelOff = false;
  await dialog.getByLabel('Código novo do autenticador').fill(FRESH_CODE);
  await dialog.getByRole('button', { name: 'Liberar número' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Liberar número' })).toHaveCount(0);
});
