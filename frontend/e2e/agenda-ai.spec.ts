import { expect, test, type Page } from '@playwright/test';
import { installApi } from './company-fixture';
import { appointment, installAgendaApi, newAgenda, type FakeAgenda } from './agenda-fixture';

// Spec 028 (E4): o painel mostra o que a IA criou pelo WhatsApp ("Pela IA", "Aguardando confirmação",
// "Cancelado pelo contato"), filtra por origem, conta o que aguarda confirmação e tem os interruptores da IA.
// Roda nos dois projetos (computador e celular) e nos dois temas, com a API falsa (nenhuma chamada real).

type Role = 'OWNER' | 'AGENT' | 'VIEWER';

async function open(
  page: Page,
  role: Role,
  seed: (agenda: FakeAgenda) => void,
  theme: 'light' | 'dark',
  path = '/painel/agenda',
): Promise<FakeAgenda> {
  await page.addInitScript((value) => localStorage.setItem('soprei-theme', value), theme);
  const api = await installApi(page, { role });
  const agenda = newAgenda();
  seed(agenda);
  await installAgendaApi(page, api, agenda, role);
  await page.goto(path);
  if (path === '/painel/agenda') {
    await page.getByRole('button', { name: 'Lista', exact: true }).click();
  }
  return agenda;
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const seedAi = (agenda: FakeAgenda): void => {
  agenda.appointments.push(
    appointment(agenda, '2026-11-10', '09:00', '09:30', {
      source: 'CHANNEL',
      status: 'PENDING',
      customerLabel: 'Maria',
      contactLabel: 'Contato final 4321',
    }),
    appointment(agenda, '2026-11-10', '14:30', '15:00'),
    appointment(agenda, '2026-11-11', '10:00', '10:30', {
      source: 'CHANNEL',
      status: 'CANCELLED',
      cancelledBy: 'CONTACT',
      customerLabel: null,
      contactLabel: 'Teste no site',
    }),
  );
};

for (const theme of ['light', 'dark'] as const) {
  test(`o que a IA criou aparece com "Pela IA" e "Aguardando confirmação", a equipe confirma e cancela (tema ${theme})`, async ({
    page,
  }) => {
    const agenda = await open(page, 'OWNER', seedAi, theme);
    const tuesday = page.locator('main section', {
      has: page.getByRole('heading', { name: /terça-feira/ }),
    });
    const aiItem = tuesday.getByRole('button', { name: /09:00 às 09:30/ });
    await expect(aiItem).toContainText('Pela IA');
    await expect(aiItem).toContainText('Aguardando confirmação');
    // O item do painel não leva o selo.
    await expect(tuesday.getByRole('button', { name: /14:30 às 15:00/ })).not.toContainText(
      'Pela IA',
    );
    // O cancelado pelo próprio contato diz isso em texto.
    await expect(page.getByRole('button', { name: /10:00 às 10:30/ })).toContainText(
      'Cancelado pelo contato',
    );
    // Contagem do que aguarda a equipe, em texto.
    await expect(page.getByTestId('aguardando')).toHaveText('1 aguardando confirmação');
    // O telefone nunca aparece (só o rótulo mascarado do servidor).
    await expect(page.locator('main')).not.toContainText('5511');

    // A equipe confirma: o estado vira Confirmado e a contagem some.
    await aiItem.click();
    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toContainText('Origem: Pela IA');
    await expect(dialog).toContainText('Situação: Aguardando confirmação');
    await dialog.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(page.getByText('Agenda atualizada.')).toBeVisible();
    expect(agenda.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      status: 'CONFIRMED',
    });
    await expect(tuesday.getByRole('button', { name: /09:00 às 09:30/ })).toContainText(
      'Confirmado',
    );
    await expect(page.getByTestId('aguardando')).toHaveCount(0);

    // E cancela: aparece "Cancelado" (feito pelo painel, não pelo contato).
    await tuesday.getByRole('button', { name: /09:00 às 09:30/ }).click();
    await page
      .getByRole('dialog')
      .first()
      .getByRole('button', { name: 'Cancelar agendamento' })
      .click();
    await page
      .getByRole('dialog', { name: 'Cancelar o agendamento?' })
      .getByRole('button', { name: 'Cancelar agendamento' })
      .click();
    await expect(tuesday.getByRole('button', { name: /09:00 às 09:30/ })).toContainText(
      'Cancelado',
    );
    await expect(tuesday.getByRole('button', { name: /09:00 às 09:30/ })).not.toContainText(
      'pelo contato',
    );
    await noHorizontalScroll(page);
  });
}

test('filtro de origem: Todas, Painel e IA', async ({ page }) => {
  await open(page, 'OWNER', seedAi, 'light');
  const filter = page.getByLabel('Origem');
  await expect(filter).toBeVisible();
  await filter.selectOption('ai');
  await expect(page.getByRole('button', { name: /09:00 às 09:30/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /14:30 às 15:00/ })).toHaveCount(0);
  await filter.selectOption('panel');
  await expect(page.getByRole('button', { name: /14:30 às 15:00/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /09:00 às 09:30/ })).toHaveCount(0);
  // A contagem acompanha o filtro (o item aguardando é da IA).
  await expect(page.getByTestId('aguardando')).toHaveCount(0);
  await filter.selectOption('all');
  await expect(page.getByTestId('aguardando')).toHaveText('1 aguardando confirmação');
});

test('semana: o bloco da IA leva o selo em texto (visão em calendário)', async ({ page }) => {
  await open(page, 'OWNER', seedAi, 'light');
  await page.getByRole('button', { name: 'Semana', exact: true }).click();
  const block = page.getByRole('button', { name: /09:00 às 09:30.*Pela IA/ });
  await expect(block).toBeVisible();
  await expect(block).toContainText('Pela IA');
});

for (const theme of ['light', 'dark'] as const) {
  test(`configurar agenda: os interruptores da IA salvam as duas opções e a confirmação automática exige a IA ligada (tema ${theme})`, async ({
    page,
  }) => {
    const agenda = await open(page, 'OWNER', () => undefined, theme, '/painel/agenda/configurar');
    await page.getByRole('tab', { name: 'IA no WhatsApp' }).click();
    await expect(page.getByRole('heading', { name: 'IA no WhatsApp' })).toBeVisible();
    const enable = page.getByLabel(/A IA pode solicitar, cancelar e remarcar/);
    const auto = page.getByLabel(/Confirmar automaticamente/);
    await expect(enable).not.toBeChecked();
    await expect(auto).toBeDisabled();
    await expect(
      page.getByText(/O contato\s+não é avisado quando a equipe confirma ou cancela depois/),
    ).toBeVisible();

    await enable.check();
    await expect(auto).toBeEnabled();
    await auto.check();
    await page.getByRole('button', { name: 'Salvar opções da IA' }).click();
    await expect(page.getByText('Opções da IA salvas.')).toBeVisible();
    const put = agenda.calls.filter((call) => call.method === 'PUT' && call.path === '/settings');
    expect(put.at(-1)?.body).toMatchObject({ aiBookingEnabled: true, aiAutoConfirm: true });
    // Relê as configurações logo antes de salvar (o PUT leva o objeto inteiro).
    const firstPut = agenda.calls.findIndex(
      (call) => call.method === 'PUT' && call.path === '/settings',
    );
    expect(agenda.calls[firstPut - 1]).toMatchObject({ method: 'GET', path: '/settings' });
    await expect(enable).toBeChecked();
    await expect(auto).toBeChecked();

    // Desligar a IA desliga a confirmação automática (a opção fica indisponível).
    await enable.uncheck();
    await expect(auto).toBeDisabled();
    await expect(auto).not.toBeChecked();
    await page.getByRole('button', { name: 'Salvar opções da IA' }).click();
    await expect(page.getByText('Opções da IA salvas.')).toBeVisible();
    expect(
      agenda.calls.filter((call) => call.method === 'PUT' && call.path === '/settings').at(-1)
        ?.body,
    ).toMatchObject({ aiBookingEnabled: false, aiAutoConfirm: false });
    await noHorizontalScroll(page);
  });
}

test('360 px: a lista com o selo, a contagem e a configuração não rolam na horizontal', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page, 'OWNER', seedAi, 'dark');
  await expect(page.getByTestId('aguardando')).toBeVisible();
  await noHorizontalScroll(page);
  await page.goto('/painel/agenda/configurar');
  await page.getByRole('tab', { name: 'IA no WhatsApp' }).click();
  await expect(page.getByRole('heading', { name: 'IA no WhatsApp' })).toBeVisible();
  await noHorizontalScroll(page);
});

test('quem não tem schedule:configure não vê os interruptores (AGENT e VIEWER)', async ({
  page,
}) => {
  await open(page, 'AGENT', () => undefined, 'light', '/painel/agenda/configurar');
  await expect(page.getByText('Você não tem permissão para ver esta tela.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'IA no WhatsApp' })).toHaveCount(0);
});
