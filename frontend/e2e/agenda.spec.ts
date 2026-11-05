import { expect, test, type Page } from '@playwright/test';
import { installApi, SENTINEL } from './company-fixture';
import { appointment, installAgendaApi, newAgenda, type FakeAgenda } from './agenda-fixture';

type Role = 'OWNER' | 'AGENT' | 'VIEWER';

async function open(
  page: Page,
  role: Role = 'OWNER',
  seed: (agenda: FakeAgenda) => void = () => undefined,
  theme: 'light' | 'dark' = 'light',
  path = '/painel/agenda',
): Promise<FakeAgenda> {
  await page.addInitScript((value) => localStorage.setItem('soprei-theme', value), theme);
  const api = await installApi(page, { role: role === 'OWNER' ? 'OWNER' : role });
  const agenda = newAgenda();
  seed(agenda);
  await installAgendaApi(page, api, agenda, role);
  await page.goto(path);
  return agenda;
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const theme of ['light', 'dark'] as const) {
  test(`a semana em lista por dia, com "Hoje", estados com texto e fuso da empresa (tema ${theme})`, async ({
    page,
  }) => {
    await open(
      page,
      'OWNER',
      (agenda) => {
        agenda.appointments.push(
          appointment(agenda, '2026-11-10', '14:30', '15:00'),
          appointment(agenda, '2026-11-10', '09:00', '09:30', {
            status: 'PENDING',
            customerLabel: 'Maria',
          }),
          appointment(agenda, '2026-11-11', '10:00', '12:00', {
            kind: 'BLOCK',
            serviceId: null,
            serviceName: null,
            customerLabel: null,
          }),
          appointment(agenda, '2026-11-12', '11:00', '11:30', { status: 'CANCELLED' }),
        );
      },
      theme,
    );
    const tabs = page.getByRole('tablist', { name: 'Menu da empresa' });
    const labels = (await tabs.innerText()).replace(/\s+/g, ' ');
    expect(labels.indexOf('Conversas')).toBeLessThan(labels.indexOf('Agenda'));
    await expect(page.getByRole('heading', { level: 2, name: '9 a 15 de novembro' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('4 agendamentos de 9 a 15 de novembro');
    // Um título por dia, com o dia de hoje marcado em texto.
    await expect(page.getByRole('heading', { level: 3 })).toHaveCount(7);
    await expect(
      page.getByRole('heading', { level: 3, name: /segunda-feira, 9 de novembro/ }),
    ).toContainText('Hoje');
    await expect(
      page.getByRole('heading', { level: 3, name: /terça-feira, 10 de novembro/ }),
    ).toBeVisible();
    const tuesday = page.locator('section', {
      has: page.getByRole('heading', { name: /terça-feira/ }),
    });
    const buttons = tuesday.getByRole('button');
    await expect(buttons).toHaveCount(2);
    await expect(buttons.first()).toContainText('09:00 às 09:30');
    await expect(buttons.first()).toContainText('Pendente');
    await expect(buttons.nth(1)).toContainText('14:30 às 15:00');
    await expect(buttons.nth(1)).toContainText('Confirmado');
    await expect(page.getByRole('button', { name: /10:00 às 12:00/ })).toContainText('Bloqueado');
    await expect(page.getByRole('button', { name: /11:00 às 11:30/ })).toContainText('Cancelado');
    await expect(page.getByText('Horários no fuso America/Sao_Paulo.')).toBeVisible();
    await expect(page.getByText(/Não registre motivo de consulta/).first()).toBeVisible();
    await noHorizontalScroll(page);
    // Usável a 360 px: sem rolagem horizontal.
    await page.setViewportSize({ width: 360, height: 740 });
    await noHorizontalScroll(page);
  });
}

test.describe('navegador em outro fuso', () => {
  test.use({ timezoneId: 'Pacific/Auckland' });
  test('os horários mostrados vêm do servidor e não mudam com o fuso do navegador', async ({
    page,
  }) => {
    await open(page, 'OWNER', (agenda) => {
      agenda.appointments.push(appointment(agenda, '2026-11-10', '23:30', '23:59'));
    });
    const tuesday = page.locator('section', {
      has: page.getByRole('heading', { name: /terça-feira/ }),
    });
    await expect(tuesday.getByRole('button').first()).toContainText('23:30 às 23:59');
    await expect(page.getByRole('heading', { level: 3 }).filter({ hasText: 'Hoje' })).toContainText(
      'segunda-feira, 9 de novembro',
    );
  });
});

test('navegar entre semanas lê o intervalo certo e anuncia a mudança', async ({ page }) => {
  const agenda = await open(page);
  await page.getByRole('button', { name: 'Próxima semana' }).click();
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('16 a 22 de novembro');
  await expect(page.getByRole('status')).toContainText('0 agendamentos de 16 a 22 de novembro');
  await page.getByRole('button', { name: 'Semana anterior' }).click();
  await page.getByRole('button', { name: 'Semana anterior' }).click();
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('2 a 8 de novembro');
  await page.getByRole('button', { name: 'Hoje' }).click();
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('9 a 15 de novembro');
  const reads = agenda.calls.filter(
    (call) => call.method === 'GET' && call.path === '/appointments',
  );
  expect(reads.length).toBeGreaterThanOrEqual(4);
});

test('marcar: escolhe o horário livre, envia o horário local e mostra na lista', async ({
  page,
}) => {
  const agenda = await open(page);
  await page.getByRole('button', { name: 'Novo agendamento' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Novo agendamento' })).toBeVisible();
  await dialog.getByRole('button', { name: '09:30' }).click();
  await dialog.getByLabel('Nome de quem será atendido (opcional)').fill('Carlos');
  await dialog.getByRole('button', { name: 'Agendar' }).click();
  await expect(page.getByText('Agendamento criado.')).toBeVisible();
  const post = agenda.calls.find((call) => call.method === 'POST' && call.path === '/appointments');
  expect(post?.body).toEqual({
    serviceId: agenda.serviceId,
    resourceId: agenda.resourceId,
    localStart: '2026-11-09T09:30',
    customerLabel: 'Carlos',
  });
  const monday = page.locator('section', {
    has: page.getByRole('heading', { name: /segunda-feira/ }),
  });
  await expect(monday.getByRole('button').first()).toContainText('09:30');
  await expect(monday.getByRole('button').first()).toContainText('Carlos');
  await expect(page.getByText(SENTINEL)).toHaveCount(0);
});

test('horário que acabou de ser ocupado: mensagem clara e os horários livres são relidos', async ({
  page,
}) => {
  const agenda = await open(page);
  agenda.takeNext = true;
  await page.getByRole('button', { name: 'Novo agendamento' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '10:00' }).click();
  const before = agenda.availabilityReads;
  await dialog.getByRole('button', { name: 'Agendar' }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Esse horário acabou de ser ocupado; escolha outro.',
  );
  await expect.poll(() => agenda.availabilityReads).toBeGreaterThan(before);
  await expect(page.getByText(SENTINEL)).toHaveCount(0);
});

test('cancelar pede confirmação, o diálogo cancela com Esc e confirmar muda o estado', async ({
  page,
}) => {
  const agenda = await open(page, 'OWNER', (seed) => {
    seed.appointments.push(appointment(seed, '2026-11-10', '14:30', '15:00'));
  });
  await page.getByRole('button', { name: /14:30 às 15:00/ }).click();
  const dialog = page.getByRole('dialog').first();
  await expect(dialog.getByRole('heading', { name: 'Agendamento' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancelar agendamento' }).click();
  const confirm = page.getByRole('dialog', { name: 'Cancelar o agendamento?' });
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  expect(agenda.calls.some((call) => call.method === 'PATCH')).toBe(false);
  await dialog.getByRole('button', { name: 'Cancelar agendamento' }).click();
  await page
    .getByRole('dialog', { name: 'Cancelar o agendamento?' })
    .getByRole('button', { name: 'Cancelar agendamento' })
    .click();
  await expect(page.getByText('Agenda atualizada.')).toBeVisible();
  const patch = agenda.calls.find((call) => call.method === 'PATCH');
  expect(patch?.body).toEqual({ status: 'CANCELLED' });
  await expect(page.getByRole('button', { name: /14:30 às 15:00/ })).toContainText('Cancelado');
});

test('o teclado percorre a lista e abre o diálogo do item', async ({ page }) => {
  await open(page, 'OWNER', (agenda) => {
    agenda.appointments.push(appointment(agenda, '2026-11-09', '09:00', '09:30'));
  });
  const item = page.getByRole('button', { name: /09:00 às 09:30/ });
  await item.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'Agendamento' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('VIEWER só lê: sem botões de escrita nem de configuração; AGENT escreve mas não configura', async ({
  page,
}) => {
  await open(page, 'VIEWER', (agenda) => {
    agenda.appointments.push(appointment(agenda, '2026-11-09', '09:00', '09:30'));
  });
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Novo agendamento' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Bloquear horário' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Configurar agenda' })).toHaveCount(0);
  await page.getByRole('button', { name: /09:00 às 09:30/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Você pode ver, mas não alterar.');
  await expect(dialog.getByRole('button', { name: 'Cancelar agendamento' })).toHaveCount(0);
});

test('AGENT vê Novo agendamento e Bloquear horário, mas não Configurar agenda; a URL da configuração é recusada', async ({
  page,
}) => {
  await open(page, 'AGENT');
  await expect(page.getByRole('button', { name: 'Novo agendamento' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bloquear horário' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Configurar agenda' })).toHaveCount(0);
  await page.goto('/painel/agenda/configurar');
  await expect(page.getByText('Você não tem permissão para ver esta tela.')).toBeVisible();
});

test('bloquear horário avisa quando há agendamento no período', async ({ page }) => {
  await open(page, 'OWNER', (agenda) => {
    agenda.appointments.push(appointment(agenda, '2026-11-09', '10:00', '10:30'));
  });
  await page.getByRole('button', { name: 'Bloquear horário' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Há 1 agendamento nesse período.');
  await dialog.getByLabel('Hora de fim').fill('09:30');
  await expect(dialog).not.toContainText('Há 1 agendamento');
});

test('configurar agenda: seções, fuso salvo no servidor e voltar à agenda', async ({ page }) => {
  const agenda = await open(page, 'OWNER', () => undefined, 'light', '/painel/agenda/configurar');
  await expect(page.getByRole('heading', { name: 'Configurar agenda' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Geral' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Serviços' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Horários de atendimento' })).toBeVisible();
  await expect(page.getByText('Corte de cabelo')).toBeVisible();
  await page.getByLabel('Fuso horário da empresa').fill('America/Manaus');
  await page.getByRole('button', { name: 'Salvar configurações' }).click();
  await expect(page.getByText('Configurações salvas.')).toBeVisible();
  const put = agenda.calls.find((call) => call.method === 'PUT' && call.path === '/settings');
  expect(put?.body).toMatchObject({ timezone: 'America/Manaus' });
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: 'Voltar à agenda' }).click();
  await expect(page).toHaveURL(/\/painel\/agenda$/);
});

test('nada da agenda vai para o armazenamento do navegador nem para o título', async ({ page }) => {
  await open(page, 'OWNER', (agenda) => {
    agenda.appointments.push(
      appointment(agenda, '2026-11-09', '09:00', '09:30', { customerLabel: 'Fulana Secreta' }),
    );
  });
  await expect(page.getByText('Fulana Secreta')).toBeVisible();
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain('Fulana');
  expect(stored).not.toContain('09:00');
  expect(await page.title()).not.toContain('Fulana');
  expect(page.url()).not.toContain('Fulana');
});

test('remarcar: escolhe a nova data e o horário livre e a lista mostra o novo horário', async ({
  page,
}) => {
  const agenda = await open(page, 'OWNER', (seed) => {
    seed.appointments.push(appointment(seed, '2026-11-10', '14:30', '15:00'));
  });
  await page.getByRole('button', { name: /14:30 às 15:00/ }).click();
  const dialog = page.getByRole('dialog').first();
  await dialog.getByRole('button', { name: 'Remarcar' }).click();
  await dialog.getByLabel('Nova data').fill('2026-11-11');
  await dialog.getByRole('button', { name: '10:00' }).click();
  await dialog.getByRole('button', { name: 'Remarcar para este horário' }).click();
  await expect(page.getByText('Agendamento remarcado.')).toBeVisible();
  const patch = agenda.calls.find((call) => call.method === 'PATCH');
  expect(patch?.body).toEqual({ localStart: '2026-11-11T10:00' });
  await expect(page.getByRole('button', { name: /10:00 às 10:00/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /14:30 às 15:00/ })).toHaveCount(0);
});

test('bloquear horário: envia o intervalo local e o bloqueio aparece como Bloqueado', async ({
  page,
}) => {
  const agenda = await open(page);
  await page.getByRole('button', { name: 'Bloquear horário' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Data de início').fill('2026-11-10');
  await dialog.getByLabel('Data de fim').fill('2026-11-10');
  await dialog.getByLabel('Hora de início').fill('12:00');
  await dialog.getByLabel('Hora de fim').fill('13:00');
  await dialog.getByRole('button', { name: 'Bloquear', exact: true }).click();
  await expect(page.getByText('Horário bloqueado.')).toBeVisible();
  const post = agenda.calls.find((call) => call.method === 'POST' && call.path === '/blocks');
  expect(post?.body).toEqual({
    resourceIds: [agenda.resourceId],
    localStart: '2026-11-10T12:00',
    localEnd: '2026-11-10T13:00',
  });
  await expect(page.getByRole('button', { name: /12:00 às 13:00/ })).toContainText('Bloqueado');
});

test('exemplo: "Carregar exemplo" só em agenda sem serviço; depois aparece "Remover exemplo"', async ({
  page,
}) => {
  const agenda = await open(
    page,
    'OWNER',
    (seed) => {
      seed.noServices = true;
    },
    'light',
    '/painel/agenda/configurar',
  );
  await expect(page.getByText('Nenhum serviço ainda.')).toBeVisible();
  await page.getByRole('button', { name: 'Carregar exemplo' }).click();
  await expect(page.getByText(/Exemplo carregado/)).toBeVisible();
  expect(agenda.calls.some((call) => call.method === 'POST' && call.path === '/sample')).toBe(true);
  await expect(page.getByText('Corte de cabelo').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Carregar exemplo' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Remover exemplo' }).click();
  await expect(page.getByText('Exemplo removido.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Carregar exemplo' })).toBeVisible();
});
