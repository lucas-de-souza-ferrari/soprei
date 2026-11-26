import { test, expect, type Page } from '@playwright/test';
import { ACCOUNT_A } from './fixtures';
import { FRESH_CODE, GOOD, hasHorizontalScroll, installFakeApi, storageSizes } from './fake-api';

// Spec 045, E4: ações do admin sobre a assinatura da conta, contra a API falsa.

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name, exact: true });

async function openAccount(page: Page): Promise<void> {
  await nav(page, 'Contas').click();
  await page.getByRole('button', { name: 'Abrir conta l***@exemplo.test' }).click();
  await expect(page.getByRole('heading', { name: 'Conta', level: 1 })).toBeVisible();
}

const base = `/platform/accounts/${ACCOUNT_A}/subscription`;

test('assinatura: conceder dias, módulos e trocar plano mandam o corpo esperado e relêem; a recusa do plano aparece', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await openAccount(page);

  await page.getByRole('button', { name: 'Conceder dias' }).click();
  const extend = page.getByRole('dialog', { name: 'Conceder dias?' });
  const days = extend.getByLabel('Dias (1 a 90)');
  await days.fill('');
  await expect(extend.getByRole('button', { name: 'Conceder dias' })).toBeDisabled();
  await days.fill('15');
  await extend.getByLabel('Motivo').selectOption({ label: 'Pagamento' });
  await extend.getByRole('button', { name: 'Conceder dias' }).click();
  await expect(extend).toBeHidden();
  expect(api.callsTo('POST', `${base}/extend`).map((call) => call.body)).toEqual([
    { days: 15, reason: 'PAYMENT' },
  ]);

  await page.getByRole('button', { name: 'Módulos' }).click();
  const modules = page.getByRole('dialog', { name: 'Mudar os módulos?' });
  const save = modules.getByRole('button', { name: 'Salvar módulos' });
  await expect(save).toBeDisabled();
  await modules.getByLabel('Estoque').check();
  await save.click();
  await expect(modules).toBeHidden();
  expect(api.callsTo('POST', `${base}/modules`).map((call) => call.body)).toEqual([
    { agenda: true, stock: true, reason: 'OWNER_REQUEST' },
  ]);

  await page.getByRole('button', { name: 'Trocar plano' }).click();
  const plan = page.getByRole('dialog', { name: 'Trocar o plano?' });
  await plan.getByLabel('Plano novo').selectOption('ESSENTIAL');
  await plan.getByRole('button', { name: 'Trocar plano' }).click();
  await expect(plan.getByRole('alert')).toContainText('não comporta as empresas da conta');
  await plan.getByLabel('Plano novo').selectOption('SCALE');
  await plan.getByRole('button', { name: 'Trocar plano' }).click();
  await expect(plan).toBeHidden();
  expect(api.callsTo('POST', `${base}/plan`).map((call) => call.body)).toEqual([
    { planCode: 'ESSENTIAL', reason: 'OWNER_REQUEST' },
    { planCode: 'SCALE', reason: 'OWNER_REQUEST' },
  ]);
  expect(await hasHorizontalScroll(page)).toBe(false);
  expect(await storageSizes(page)).toEqual([0, 0]);
});

test('assinatura: cancelar e desfazer; encerrar agora pede o código novo (o do login é recusado)', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await openAccount(page);

  await page.getByRole('button', { name: 'Cancelar no fim do período' }).click();
  await page
    .getByRole('dialog', { name: 'Cancelar no fim do período?' })
    .getByRole('button', { name: 'Cancelar no fim do período' })
    .click();
  await expect(page.getByRole('button', { name: 'Desfazer cancelamento' })).toBeVisible();
  await page.getByRole('button', { name: 'Desfazer cancelamento' }).click();
  await page
    .getByRole('dialog', { name: 'Desfazer o cancelamento?' })
    .getByRole('button', { name: 'Desfazer cancelamento' })
    .click();
  await expect(page.getByRole('button', { name: 'Cancelar no fim do período' })).toBeVisible();

  await page.getByRole('button', { name: 'Encerrar agora' }).click();
  const end = page.getByRole('dialog', { name: 'Encerrar a assinatura agora?' });
  await expect(
    end.getByText('o atendimento de todas as empresas da conta para', { exact: false }),
  ).toBeVisible();
  const code = end.getByLabel('Código novo do autenticador');
  await code.fill(GOOD.code);
  await end.getByRole('button', { name: 'Encerrar agora' }).click();
  await expect(end.getByRole('alert')).toContainText('Código do autenticador inválido ou já usado');
  await code.fill(FRESH_CODE);
  await end.getByRole('button', { name: 'Encerrar agora' }).click();
  await expect(end).toBeHidden();
  // Encerrada (bloqueada): não há mais o que cancelar nem encerrar.
  await expect(page.getByRole('button', { name: 'Encerrar agora' })).toHaveCount(0);
  expect(api.callsTo('POST', `${base}/end`).map((call) => call.body)).toEqual([
    { reason: 'OWNER_REQUEST', code: GOOD.code },
    { reason: 'OWNER_REQUEST', code: FRESH_CODE },
  ]);
  await expect(page.getByText(FRESH_CODE, { exact: true })).toHaveCount(0);
});

test('assinatura: pedido pendente mostra a recusa própria; sem assinatura só aparece "Iniciar teste"', async ({
  page,
}) => {
  const api = await installFakeApi(page, { signedIn: true });
  api.orderPending = true;
  await page.goto('/');
  await openAccount(page);
  await page.getByRole('button', { name: 'Conceder dias' }).click();
  const extend = page.getByRole('dialog', { name: 'Conceder dias?' });
  await extend.getByRole('button', { name: 'Conceder dias' }).click();
  await expect(extend.getByRole('alert')).toContainText('Há um pagamento pendente');
  await extend.getByRole('button', { name: 'Cancelar' }).click();

  api.accountSubscription = null;
  await page.getByRole('button', { name: 'Atualizar' }).click();
  await expect(page.getByText('Sem assinatura.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Conceder dias' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Iniciar teste' }).click();
  await page
    .getByRole('dialog', { name: 'Iniciar o teste gratuito?' })
    .getByRole('button', { name: 'Iniciar teste' })
    .click();
  await expect(page.getByRole('button', { name: 'Conceder dias' })).toBeVisible();
  expect(api.callsTo('POST', `${base}/trial`).map((call) => call.body)).toEqual([
    { reason: 'OWNER_REQUEST' },
  ]);
});

test('empresa: "Abrir conta titular" leva à conta dona da assinatura, onde ficam as ações', async ({
  page,
}) => {
  await installFakeApi(page, { signedIn: true });
  await page.goto('/');
  await nav(page, 'Empresas').click();
  await page.getByRole('button', { name: 'Abrir Padaria Aurora' }).click();
  await page.getByRole('button', { name: 'Abrir conta titular' }).click();
  await expect(page.getByRole('heading', { name: 'Conta', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Conceder dias' })).toBeVisible();
});
