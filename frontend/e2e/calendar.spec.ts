import { expect, test, type Page } from '@playwright/test';
import { installApi, SENTINEL } from './company-fixture';
import { appointment, installAgendaApi, newAgenda, type FakeAgenda } from './agenda-fixture';

// Spec 029 (E4): calendário da agenda (semana e mês). O navegador roda em outro fuso (Pacific/Kiritimati,
// UTC+14) para provar que ele só mostra o que o servidor devolve e nunca converte.
test.use({ timezoneId: 'Pacific/Kiritimati' });

type Role = 'OWNER' | 'AGENT' | 'VIEWER';

async function open(
  page: Page,
  role: Role,
  seed: (agenda: FakeAgenda) => void,
  view: 'Lista' | 'Semana' | 'Mês' | null = null,
): Promise<{ agenda: FakeAgenda; requests: string[] }> {
  const api = await installApi(page, { role });
  const agenda = newAgenda();
  seed(agenda);
  await installAgendaApi(page, api, agenda, role);
  const requests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/schedule/appointments') && request.method() === 'GET')
      requests.push(`${url.searchParams.get('from') ?? ''}..${url.searchParams.get('to') ?? ''}`);
  });
  await page.goto('/painel/agenda');
  if (view !== null) await page.getByRole('button', { name: view, exact: true }).click();
  return { agenda, requests };
}

function seedWeek(agenda: FakeAgenda): void {
  agenda.appointments.push(
    appointment(agenda, '2026-11-10', '09:00', '09:30', { customerLabel: 'João' }),
    appointment(agenda, '2026-11-10', '09:15', '10:00', { customerLabel: 'Ana' }),
    appointment(agenda, '2026-11-11', '11:00', '11:30', { status: 'CANCELLED' }),
    appointment(agenda, '2026-11-12', '14:00', '15:00', { customerLabel: 'Carlos' }),
    appointment(agenda, '2026-11-13', '12:00', '13:00', {
      kind: 'BLOCK',
      serviceId: null,
      serviceName: null,
      customerLabel: null,
    }),
  );
}

const day = (page: Page, heading: string | RegExp) => page.getByRole('region', { name: heading });
/** Só os itens (não o botão "Agendar" do cabeçalho do dia): a coluna de corpo do dia. */
const items = (page: Page, date: string) => page.getByTestId(`dia-${date}`).getByRole('button');
const noScroll = (page: Page) =>
  page.evaluate(() => {
    const element = document.scrollingElement;
    return element !== null && element.scrollWidth <= element.clientWidth;
  });

test('visão padrão (Semana no computador, Lista no celular) e troca sem recarregar nada', async ({
  page,
}, testInfo) => {
  const { requests } = await open(page, 'OWNER', seedWeek);
  const mobile = testInfo.project.name === 'mobile';
  await expect(
    page.getByRole('button', { name: mobile ? 'Lista' : 'Semana', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  const title = await page.title();
  const url = page.url();
  const before = requests.length;
  await page.getByRole('button', { name: 'Mês', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mês', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Lista', exact: true }).click();
  await expect(page.getByRole('heading', { level: 3 }).first()).toBeVisible();
  expect(requests.length).toBeGreaterThan(before);
  // A escolha vive só na memória da tela.
  expect(page.url()).toBe(url);
  expect(await page.title()).toBe(title);
  const keys = await page.evaluate(() => [
    ...Object.keys(localStorage),
    ...Object.keys(sessionStorage),
  ]);
  expect(keys.filter((key) => key !== 'soprei-theme')).toEqual([]);
});

test('semana: itens na coluna e na hora do servidor (navegador em outro fuso), sobreposição lado a lado', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'grade completa só no computador');
  const { requests } = await open(page, 'OWNER', seedWeek, 'Semana');
  const tuesday = day(page, /terça-feira, 10 de novembro/);
  const joao = tuesday.getByRole('button', {
    name: /09:00 às 09:30, Corte de cabelo, João, Confirmado/,
  });
  const ana = tuesday.getByRole('button', {
    name: /09:15 às 10:00, Corte de cabelo, Ana, Confirmado/,
  });
  await expect(joao).toBeVisible();
  await expect(ana).toBeVisible();
  const thursday = day(page, /quinta-feira, 12 de novembro/);
  const carlos = thursday.getByRole('button', { name: /14:00 às 15:00/ });
  const a = await joao.boundingBox();
  const b = await ana.boundingBox();
  const c = await carlos.boundingBox();
  if (a === null || b === null || c === null) throw new Error('sem caixa');
  // 09:00 -> 14:00 são 5 horas de 72 px.
  expect(Math.abs(c.y - a.y - 5 * 72)).toBeLessThan(3);
  // Sobrepostos: lado a lado (sem cobrir um ao outro) e dentro da mesma coluna.
  expect(Math.abs(a.x - b.x)).toBeGreaterThan(20);
  const column = await tuesday.boundingBox();
  if (column === null) throw new Error('sem coluna');
  expect(a.x).toBeGreaterThanOrEqual(column.x - 1);
  expect(b.x + b.width).toBeLessThanOrEqual(column.x + column.width + 1);
  // Cancelado e bloqueio com texto, não só cor.
  await expect(items(page, '2026-11-11')).toContainText('Cancelado');
  await expect(items(page, '2026-11-13')).toContainText('Bloqueado');
  await expect(page.getByText('Hoje', { exact: true }).first()).toBeVisible();

  // Navegação: sete dias para cada lado e a mudança é anunciada.
  await page.getByRole('button', { name: 'Próxima semana' }).click();
  await expect(page.getByRole('heading', { level: 2 })).toContainText('16 a 22 de novembro');
  await expect(page.getByRole('status')).toContainText('16 a 22 de novembro');
  expect(requests.at(-1)).toBe('2026-11-16..2026-11-22');
  await page.getByRole('button', { name: 'Hoje' }).click();
  await expect(page.getByRole('heading', { level: 2 })).toContainText('9 a 15 de novembro');
  await page.getByRole('button', { name: 'Semana anterior' }).click();
  expect(requests.at(-1)).toBe('2026-11-02..2026-11-08');
});

test('mês: grade de 6 semanas, até 3 itens e "+N" que abre o dia na semana', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'células completas só no computador');
  const { requests } = await open(
    page,
    'OWNER',
    (agenda) => {
      for (let index = 0; index < 5; index++)
        agenda.appointments.push(
          appointment(
            agenda,
            '2026-11-10',
            `0${String(8 + index)}:00`.slice(-5),
            `0${String(8 + index)}:30`.slice(-5),
            {
              customerLabel: `Pessoa ${String(index)}`,
            },
          ),
        );
    },
    'Mês',
  );
  await expect(page.getByRole('heading', { level: 2 })).toContainText(/novembro de 2026/i);
  await expect(page.locator('ol[aria-label^="Dias do mês"] > li')).toHaveCount(42);
  expect(requests.at(-1)).toBe('2026-10-26..2026-12-06');
  const cell = page.locator('ol[aria-label^="Dias do mês"] > li').filter({ hasText: '08:00' });
  await expect(cell.getByRole('button', { name: /Pessoa/ })).toHaveCount(3);
  await expect(cell.getByRole('button', { name: /^Mais 2 em/ })).toHaveText('+2');
  await expect(
    page.locator('ol[aria-label^="Dias do mês"] > li').filter({ hasText: 'Hoje' }),
  ).toHaveCount(1);
  await cell.getByRole('button', { name: /^Mais 2 em/ }).click();
  await expect(page.getByRole('button', { name: 'Semana', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('heading', { level: 2 })).toContainText('9 a 15 de novembro');
  await page.getByRole('button', { name: 'Mês', exact: true }).click();
  await page.getByRole('button', { name: 'Próximo mês' }).click();
  await expect(page.getByRole('heading', { level: 2 })).toContainText(/dezembro de 2026/i);
  expect(requests.at(-1)).toBe('2026-11-30..2027-01-10');
  await page.getByRole('button', { name: 'Mês anterior' }).click();
  await page.getByRole('button', { name: 'Mês anterior' }).click();
  await expect(page.getByRole('heading', { level: 2 })).toContainText(/outubro de 2026/i);
});

test('mês com itens demais: mensagem constante, sem truncar, e a saída pela Semana', async ({
  page,
}) => {
  await open(page, 'OWNER', seedWeek);
  await page.route('**/api/admin/companies/*/schedule/appointments*', async (route) => {
    const url = new URL(route.request().url());
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 7 * 86_400_000) {
      await route.fulfill({
        status: 400,
        json: { error: { code: 'RANGE_TOO_LARGE', message: SENTINEL, requestId: 'x' } },
      });
      return;
    }
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Mês', exact: true }).click();
  await expect(
    page.getByText(
      'Há itens demais neste mês para mostrar. Use a visão Semana ou filtre por serviço.',
    ),
  ).toBeVisible();
  await expect(page.locator('body')).not.toContainText(SENTINEL);
  await expect(page.locator('ol[aria-label^="Dias do mês"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Ver a semana' }).click();
  await expect(page.getByRole('button', { name: 'Semana', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: /14:00 às 15:00/ })).toBeVisible();
});

test('clicar no item abre o diálogo: cancelar (com confirmação), remarcar e remover bloqueio', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'blocos da semana só no computador');
  const { agenda } = await open(page, 'OWNER', seedWeek, 'Semana');
  // Teclado: o foco volta ao item de origem depois de Esc.
  const carlos = day(page, /quinta-feira, 12 de novembro/).getByRole('button', {
    name: /14:00 às 15:00/,
  });
  await carlos.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'Agendamento' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(carlos).toBeFocused();

  // Cancelar com confirmação.
  await carlos.click();
  const dialog = page.getByRole('dialog').first();
  await dialog.getByRole('button', { name: 'Cancelar agendamento' }).click();
  await page
    .getByRole('dialog', { name: 'Cancelar o agendamento?' })
    .getByRole('button', { name: 'Cancelar agendamento' })
    .click();
  await expect(page.getByText('Agenda atualizada.')).toBeVisible();
  expect(agenda.appointments.find((item) => item.localStart === '14:00')?.status).toBe('CANCELLED');
  await expect(items(page, '2026-11-12')).toContainText('Cancelado');

  // Remarcar: o item muda de dia.
  await day(page, /terça-feira, 10 de novembro/)
    .getByRole('button', { name: /09:00 às 09:30/ })
    .click();
  const reschedule = page.getByRole('dialog').first();
  await reschedule.getByRole('button', { name: 'Remarcar' }).click();
  await reschedule.getByLabel('Nova data').fill('2026-11-11');
  await reschedule.getByRole('button', { name: '10:00' }).click();
  await reschedule.getByRole('button', { name: 'Remarcar para este horário' }).click();
  await expect(page.getByText('Agendamento remarcado.')).toBeVisible();
  await expect(
    day(page, /quarta-feira, 11 de novembro/).getByRole('button', { name: /10:00/ }),
  ).toBeVisible();

  // Remover bloqueio.
  await items(page, '2026-11-13').click();
  await page.getByRole('dialog').first().getByRole('button', { name: 'Remover bloqueio' }).click();
  await page
    .getByRole('dialog', { name: 'Remover o bloqueio?' })
    .getByRole('button', { name: 'Remover bloqueio' })
    .click();
  await expect(items(page, '2026-11-13')).toHaveCount(0);
});

test('item que sumiu (404) e horário ocupado mostram as mesmas mensagens da lista', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'blocos da semana só no computador');
  await open(page, 'OWNER', seedWeek, 'Semana');
  await page.route('**/api/admin/companies/*/schedule/appointments/*', async (route) => {
    if (route.request().method() === 'PATCH')
      await route.fulfill({
        status: 404,
        json: { error: { code: 'NOT_FOUND', message: SENTINEL, requestId: 'x' } },
      });
    else await route.fallback();
  });
  await items(page, '2026-11-12').click();
  await page
    .getByRole('dialog')
    .first()
    .getByRole('button', { name: 'Cancelar agendamento' })
    .click();
  await page
    .getByRole('dialog', { name: 'Cancelar o agendamento?' })
    .getByRole('button', { name: 'Cancelar agendamento' })
    .click();
  await expect(page.getByText('Este item não existe mais. A agenda foi atualizada.')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(SENTINEL);
});

test('clicar em faixa vazia abre Novo agendamento com data e hora; VIEWER não tem esse clique', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'faixas da semana só no computador');
  await open(page, 'OWNER', seedWeek, 'Semana');
  // 100 px abaixo do topo da coluna (13 h x 72 px): 07:00 + 100/936 de 780 min = 08:23 -> 08:15.
  await page.getByTestId('dia-2026-11-11').click({ position: { x: 20, y: 100 } });
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Novo agendamento' })).toBeVisible();
  await expect(dialog.getByLabel('Data')).toHaveValue('2026-11-11');
  await expect(dialog.getByLabel('Horário do encaixe')).toHaveValue('08:15');
  await page.keyboard.press('Escape');

  // Mês: o número do dia pré-preenche a data.
  await page.getByRole('button', { name: 'Mês', exact: true }).click();
  await page
    .getByRole('button', { name: /^Novo agendamento em quinta-feira, 12 de novembro/ })
    .click();
  await expect(page.getByRole('dialog').getByLabel('Data')).toHaveValue('2026-11-12');
  await page.keyboard.press('Escape');
});

test('VIEWER: a faixa vazia não é clicável e o item abre só para leitura', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'faixas da semana só no computador');
  await open(page, 'VIEWER', seedWeek, 'Semana');
  await expect(page.getByRole('button', { name: /^Novo agendamento em/ })).toHaveCount(0);
  await page.getByTestId('dia-2026-11-11').click({ position: { x: 20, y: 100 } });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await items(page, '2026-11-12').click();
  await expect(page.getByRole('dialog')).toContainText('Você pode ver, mas não alterar.');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Mês', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Novo agendamento em/ })).toHaveCount(0);
});

test('teclado: Tab segue a ordem do tempo dentro do dia e o foco é visível', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'blocos da semana só no computador');
  await open(page, 'OWNER', seedWeek, 'Semana');
  const tuesday = day(page, /terça-feira, 10 de novembro/);
  const first = tuesday.getByRole('button', { name: /09:00 às 09:30/ });
  const second = tuesday.getByRole('button', { name: /09:15 às 10:00/ });
  // Foco pelo teclado (para valer :focus-visible): o anel aparece e Tab segue a ordem do tempo.
  await second.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(first).toBeFocused();
  const outline = await first.evaluate((node) => getComputedStyle(node).outlineStyle);
  expect(outline).not.toBe('none');
  await page.keyboard.press('Tab');
  await expect(second).toBeFocused();
});

test('celular: a Lista segue completa, a Semana rola dentro da grade e o Mês abre o dia na lista', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'só no celular');
  await open(page, 'OWNER', seedWeek);
  // Lista padrão e completa.
  await expect(page.getByRole('heading', { level: 3 }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /14:00 às 15:00/ })).toBeVisible();
  // Semana: rola na horizontal dentro da grade, sem estourar a página, com o eixo de horas fixo.
  await page.getByRole('button', { name: 'Semana', exact: true }).click();
  const grid = page.getByTestId('week-grid');
  await expect(grid).toBeVisible();
  expect(await grid.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await noScroll(page)).toBe(true);
  const axis = page.getByTestId('week-grid').locator('div.sticky').first();
  const before = await axis.boundingBox();
  await grid.evaluate((node) => node.scrollTo({ left: 300 }));
  const after = await axis.boundingBox();
  if (before === null || after === null) throw new Error('sem eixo');
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  // Mês: tocar no dia abre a lista daquele dia.
  await page.getByRole('button', { name: 'Mês', exact: true }).click();
  expect(await noScroll(page)).toBe(true);
  await page.getByRole('button', { name: /^terça-feira, 10 de novembro, 2 agendamentos/ }).click();
  await expect(page.getByRole('button', { name: 'Lista', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('#dia-2026-11-10')).toBeFocused();
});

test('semana e mês em 360 px não estouram a página', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page, 'OWNER', seedWeek);
  for (const view of ['Semana', 'Mês', 'Lista'] as const) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await expect(page.getByRole('button', { name: view, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await noScroll(page), view).toBe(true);
  }
});

test('privacidade: nada de serviço, atendido ou horário em console, título, URL, armazenamento ou data-*', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'blocos da semana só no computador');
  const logs: string[] = [];
  page.on('console', (entry) => logs.push(entry.text()));
  page.on('pageerror', (error) => logs.push(error.message));
  await open(
    page,
    'OWNER',
    (agenda) => {
      agenda.appointments.push(
        appointment(agenda, '2026-11-10', '09:00', '09:30', { customerLabel: 'SEGREDO-ATENDIDO' }),
      );
    },
    'Semana',
  );
  await expect(page.getByRole('button', { name: /SEGREDO-ATENDIDO/ })).toBeVisible();
  await page.getByRole('button', { name: 'Mês', exact: true }).click();
  const state = await page.evaluate(() => ({
    local: JSON.stringify({ ...localStorage }),
    session: JSON.stringify({ ...sessionStorage }),
    title: document.title,
    href: location.href,
    data: [...document.querySelectorAll('*')].flatMap((node) =>
      node
        .getAttributeNames()
        .filter((name) => name.startsWith('data-'))
        .map((name) => node.getAttribute(name) ?? ''),
    ),
  }));
  for (const value of [state.local, state.session, state.title, state.href, ...state.data, ...logs])
    expect(value).not.toContain('SEGREDO-ATENDIDO');
});

test('item que termina à meia-noite ("00:00") fica no dia e não gera bloco no seguinte', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'blocos da semana só no computador');
  await open(
    page,
    'OWNER',
    (agenda) => {
      agenda.appointments.push(appointment(agenda, '2026-11-14', '23:30', '00:00'));
    },
    'Semana',
  );
  await expect(items(page, '2026-11-14')).toHaveCount(1);
  await expect(items(page, '2026-11-14')).toContainText('23:30 às 00:00');
  await expect(items(page, '2026-11-15')).toHaveCount(0);
});
