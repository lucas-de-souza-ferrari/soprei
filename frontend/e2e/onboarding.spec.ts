import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { goTo, menuItems } from './company-fixture';
import { noHorizontalScroll, openWizard, writes } from './onboarding-fixture';

// Spec 030: assistente de primeiros passos. API falsa (nada sai para a internet).

const step = (page: Page) => page.getByTestId('passo-atual');
const heading = (page: Page, name: string) =>
  page.getByRole('heading', { name, level: 2, exact: true });

test('conta nova sem empresa: criar abre o passo 2 (persona) com o passo 1 feito', async ({
  page,
}) => {
  const { api } = await openWizard(page, {
    path: '/entrar',
    api: { companies: [], selected: null },
  });
  await expect(page.getByLabel('Nome da empresa')).toBeVisible();
  await page.getByLabel('Nome da empresa').fill('Minha Loja');
  await page.getByRole('button', { name: 'Criar empresa' }).click();
  await expect(page).toHaveURL(/\/painel\/primeiros-passos\/persona$/);
  await expect(step(page)).toHaveText('Passo 2 de 6');
  await expect(heading(page, 'Persona do atendente')).toBeFocused();
  const progress = page.getByRole('progressbar');
  await expect(progress).toHaveAttribute('aria-valuenow', '2');
  await expect(progress).toHaveAttribute('aria-valuemax', '6');
  if (await page.getByRole('button', { name: 'Ver passos' }).isVisible()) {
    await page.getByRole('button', { name: 'Ver passos' }).click();
  }
  const list = page.getByRole('navigation', { name: 'Passos' });
  await expect(list.getByRole('listitem').first()).toContainText('Empresa');
  await expect(list.getByRole('listitem').first()).toContainText('Feito');
  expect(
    api.calls.filter((call) => call.method === 'POST' && call.path === '/account/companies'),
  ).toHaveLength(1);
});

for (const theme of ['light', 'dark'] as const) {
  test(`persona: usar modelo só preenche; salvar chama a rota existente e o passo fica feito (tema ${theme})`, async ({
    page,
  }) => {
    const { api, onb } = await openWizard(page, { theme });
    await expect(page).toHaveURL(/\/painel\/primeiros-passos\/persona$/);
    await expect(step(page)).toHaveText('Passo 2 de 6');
    await page.getByRole('button', { name: 'Usar modelo' }).click();
    // Nada foi salvo só por preencher.
    expect(writes(api, onb)).toHaveLength(0);
    await expect(page.getByLabel('Persona do assistente')).toHaveValue(/\[nome da empresa\]/);
    await expect(page.getByRole('button', { name: 'Salvar e continuar' })).toBeVisible();
    await page.getByLabel('Persona do assistente').fill('Atendente simpático da Loja X.');
    await page.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect(page.getByText('Persona salva.')).toBeVisible();
    expect(api.persona).toBe('Atendente simpático da Loja X.');
    // O progresso é relido do servidor: Persona passa a feita e o botão volta a "Continuar".
    await expect(page.getByRole('button', { name: 'Continuar' })).toBeVisible();
    if (await page.getByRole('button', { name: 'Ver passos' }).isVisible()) {
      await page.getByRole('button', { name: 'Ver passos' }).click();
    }
    await expect(
      page.getByRole('navigation', { name: 'Passos' }).getByRole('listitem').nth(1),
    ).toContainText('Feito');
  });
}

test('"Salvar e continuar" grava o rascunho e avança; o foco vai ao título do novo passo', async ({
  page,
}) => {
  const { api } = await openWizard(page);
  await page.getByLabel('Persona do assistente').fill('Persona de teste');
  await page.getByRole('button', { name: 'Salvar e continuar' }).click();
  await expect(page).toHaveURL(/\/painel\/primeiros-passos\/documentos$/);
  await expect(step(page)).toHaveText('Passo 3 de 6');
  await expect(heading(page, 'Documentos')).toBeFocused();
  expect(api.persona).toBe('Persona de teste');
});

test('rascunho não salvo: sair pede confirmação; cancelar mantém; confirmar descarta; nada no navegador', async ({
  page,
}) => {
  const { api, onb } = await openWizard(page);
  const secret = 'rascunho-secreto-da-persona';
  await page.getByLabel('Persona do assistente').fill(secret);
  await page.getByRole('button', { name: 'Pular' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Você tem texto não salvo. Sair e descartar?');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page).toHaveURL(/\/persona$/);
  await expect(page.getByLabel('Persona do assistente')).toHaveValue(secret);
  const stored = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    href: location.href,
    title: document.title,
  }));
  expect(stored.local.filter((key) => key !== 'soprei-theme')).toEqual([]);
  expect(stored.session).toEqual([]);
  expect(stored.href).not.toContain(secret);
  expect(stored.title).not.toContain(secret);
  await page.getByRole('button', { name: 'Pular' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sair e descartar' }).click();
  await expect(page).toHaveURL(/\/documentos$/);
  expect(api.persona).toBeNull();
  expect(writes(api, onb)).toHaveLength(0);
});

test('pular os passos de persona e documentos não grava nada; Voltar do navegador volta ao passo anterior', async ({
  page,
}) => {
  const { api, onb } = await openWizard(page);
  await page.getByRole('button', { name: 'Pular' }).click();
  await expect(page).toHaveURL(/\/documentos$/);
  await expect(step(page)).toHaveText('Passo 3 de 6');
  await page.getByRole('button', { name: 'Pular' }).click();
  await expect(page).toHaveURL(/\/servicos$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/documentos$/);
  await expect(heading(page, 'Documentos')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/persona$/);
  expect(writes(api, onb)).toHaveLength(0);
});

test('documentos: colar e salvar usa a rota existente e o passo fica feito', async ({ page }) => {
  const { onb } = await openWizard(page, { path: '/painel/primeiros-passos/documentos' });
  await expect(step(page)).toHaveText('Passo 3 de 6');
  await page.getByLabel('Título do documento').fill('Política de trocas');
  await page.getByLabel('Texto do documento').fill('Aceitamos trocas em até 7 dias.');
  await expect(page.getByRole('button', { name: 'Salvar e continuar' })).toBeVisible();
  await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
  await expect(page.getByText('Documento adicionado.')).toBeVisible();
  expect(onb.docs).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Continuar' })).toBeVisible();
});

test('exemplo de documentos: avisa que cria produtos, marca Documentos e Estoque como feitos e some o botão', async ({
  page,
}) => {
  const { onb } = await openWizard(page, { path: '/painel/primeiros-passos/documentos' });
  await expect(page.getByText('também cria produtos de mentira')).toBeVisible();
  await page.getByRole('button', { name: 'Carregar exemplo' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Carregar', exact: true }).click();
  await expect(page.getByText('Exemplo carregado.')).toBeVisible();
  expect(onb.calls.some((c) => c.method === 'POST' && c.path.endsWith('/knowledge/sample'))).toBe(
    true,
  );
  expect(onb.docs).toHaveLength(2);
  expect(onb.products).toHaveLength(8);
  await expect(page.getByRole('button', { name: 'Carregar exemplo' })).toHaveCount(0);
  if (await page.getByRole('button', { name: 'Ver passos' }).isVisible()) {
    await page.getByRole('button', { name: 'Ver passos' }).click();
  }
  const items = page.getByRole('navigation', { name: 'Passos' }).getByRole('listitem');
  await expect(items.nth(2)).toContainText('Feito');
  await expect(items.nth(4)).toContainText('Feito');
});

test('com documento já cadastrado o botão de exemplo não aparece', async ({ page }) => {
  await openWizard(page, {
    path: '/painel/primeiros-passos/documentos',
    seed: (_api, onb) => onb.docs.push({ id: randomUUID(), title: 'Meu doc', isSample: false }),
  });
  await expect(page.getByText('Meu doc')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Carregar exemplo' })).toHaveCount(0);
});

test('retomar: persona feita, recarregar e abrir pelo menu cai no primeiro passo pendente', async ({
  page,
}) => {
  await openWizard(page, {
    path: '/painel/conversas',
    api: { persona: 'Já definida' },
  });
  await goTo(page, 'Primeiros passos');
  await expect(page).toHaveURL(/\/painel\/primeiros-passos\/documentos$/);
  await page.reload();
  await expect(page).toHaveURL(/\/painel\/primeiros-passos\/documentos$/);
  await expect(step(page)).toHaveText('Passo 3 de 6');
});

test('endereço com passo inexistente cai no primeiro pendente, sem chamar API de passo inexistente', async ({
  page,
}) => {
  const { onb } = await openWizard(page, { path: '/painel/primeiros-passos/inexistente' });
  await expect(page).toHaveURL(/\/painel\/primeiros-passos\/persona$/);
  expect(onb.calls.filter((c) => c.path.includes('inexistente'))).toHaveLength(0);
});

for (const role of ['AGENT', 'VIEWER'] as const) {
  test(`${role} não vê o assistente: sem item de menu e sem chamada a /onboarding; o endereço mostra "sem permissão"`, async ({
    page,
  }) => {
    const { onb } = await openWizard(page, { role, path: '/painel/conversas' });
    expect(await menuItems(page)).not.toContain('Primeiros passos');
    await page.goto('/painel/primeiros-passos');
    await expect(page.getByText('Você não tem permissão para ver esta tela.')).toBeVisible();
    expect(onb.calls.filter((c) => c.path.endsWith('/onboarding'))).toHaveLength(0);
  });
}

test('ADMIN (entrou por convite) vê o item de menu, mas o assistente não abre sozinho', async ({
  page,
}) => {
  await openWizard(page, { role: 'ADMIN', path: '/entrar' });
  await expect(page).toHaveURL(/\/painel\/conversas$/);
  expect(await menuItems(page)).toContain('Primeiros passos');
});

test('falha ao ler o estado: aviso com "Tentar de novo", sem texto do servidor', async ({
  page,
}) => {
  const { onb } = await openWizard(page, { seed: (_api, state) => (state.failState = true) });
  await expect(page.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
  await expect(page.getByText('TEXTO-DO-SERVIDOR-QUE-NAO-PODE-APARECER')).toHaveCount(0);
  onb.failState = false;
  await page.getByRole('button', { name: 'Tentar de novo' }).click();
  await expect(step(page)).toHaveText('Passo 2 de 6');
});

test('celular: sem rolagem horizontal e lista de passos utilizável', async ({ page }) => {
  await openWizard(page);
  await expect(step(page)).toBeVisible();
  await noHorizontalScroll(page);
  const toggle = page.getByRole('button', { name: /(Ver|Ocultar) passos/ });
  if (await toggle.isVisible()) {
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page
      .getByRole('navigation', { name: 'Passos' })
      .getByRole('button', { name: /Documentos/ })
      .click();
    await expect(page).toHaveURL(/\/documentos$/);
    await noHorizontalScroll(page);
  }
});
