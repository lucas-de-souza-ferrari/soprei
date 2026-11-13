import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  CHECKOUT_HOST,
  installBillingApi,
  newBilling,
  type FakeBilling,
  type FakeSubscription,
} from './billing-fixture';
import { installApi, menuItems, SENTINEL, type FakeApi, type Role } from './company-fixture';
import { installOnboardingApi, newOnboarding, ONBOARDING_PERMISSIONS } from './onboarding-fixture';

// Spec 031 (E4): tela de Assinatura. API falsa (nada sai para a internet; a página de pagamento é um HTML falso).

async function open(
  page: Page,
  options: {
    billing?: Partial<FakeBilling>;
    sub?: Partial<FakeSubscription>;
    role?: Role;
    theme?: 'light' | 'dark';
    path?: string;
    width?: number;
    clock?: boolean;
    /** Permissões completas do proprietário (agenda, estoque, primeiros passos...). */
    full?: boolean;
  } = {},
): Promise<{ api: FakeApi; billing: FakeBilling }> {
  await page.addInitScript(
    (value) => localStorage.setItem('soprei-theme', value),
    options.theme ?? 'light',
  );
  if (options.width !== undefined)
    await page.setViewportSize({ width: options.width, height: 800 });
  const api = await installApi(page, { role: options.role ?? 'OWNER' });
  if (options.full === true) {
    for (const item of api.companies) item.permissions = ONBOARDING_PERMISSIONS.OWNER;
  }
  const base = newBilling(options.billing);
  const billing: FakeBilling = {
    ...base,
    sub:
      options.billing?.sub === null
        ? null
        : base.sub === null
          ? null
          : { ...base.sub, ...options.sub },
  };
  await installBillingApi(page, api, billing);
  if (options.clock === true) await page.clock.install();
  await page.goto(options.path ?? '/painel/assinatura');
  return { api, billing };
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const writes = (billing: FakeBilling) => billing.calls.filter((call) => call.method !== 'GET');
const page_ = (page: Page) => page.getByTestId('assinatura');

for (const theme of ['light', 'dark'] as const) {
  test(`plano atual, ciclo, módulos, vencimento, uso, estimativa e aviso do WhatsApp; menu com Assinatura antes de Primeiros passos (tema ${theme})`, async ({
    page,
  }) => {
    await open(page, {
      theme,
      full: true,
      sub: { endsInDays: 20 },
      billing: {
        usage: { replies: [2125, 2500], tokens: [3_000_000, 15_000_000], milliCents: 420_000 },
      },
    });
    await expect(page.getByRole('heading', { level: 1, name: 'Assinatura' })).toBeVisible();
    await expect(page_(page)).toContainText('Essencial');
    await expect(page_(page)).toContainText('Mensal');
    await expect(page_(page)).toContainText('Agenda: contratada');
    await expect(page_(page)).toContainText('Estoque: não contratado');
    await expect(page_(page)).toContainText('Assinatura ativa');
    // Barras de uso com valor e porcentagem; 85% é atenção, em texto (não só cor).
    const replies = page.getByTestId('uso-respostas');
    await expect(replies).toContainText('2.125 de 2.500 respostas (85%)');
    await expect(replies.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2125');
    await expect(page.getByTestId('alerta-respostas')).toContainText('80% ou mais');
    // Spec 040 (E2): só a barra de respostas; o limite de uso da IA (tokens) fica fora da tela.
    await expect(page_(page)).toContainText('Respostas enviadas pelo WhatsApp neste mês');
    await expect(page_(page).getByRole('progressbar')).toHaveCount(1);
    await expect(page.getByTestId('uso-ia')).toHaveCount(0);
    // Estimativa da Meta marcada como estimativa e o aviso fixo do modo vigente.
    const estimate = page.getByTestId('estimativa-meta');
    await expect(estimate).toContainText('Estimativa de custo na Meta este mês');
    await expect(estimate).toContainText('R$ 4,20 (estimativa)');
    await expect(estimate).toContainText('valor real vem da fatura da Meta');
    await expect(page.getByTestId('aviso-whatsapp')).toContainText(
      'O plano não inclui o custo das mensagens do WhatsApp: a Meta cobra direto da conta do WhatsApp da sua empresa.',
    );
    const labels = await menuItems(page);
    expect(labels.at(-1)).toBe('Primeiros passos');
    expect(labels.at(-2)).toBe('Assinatura');
    await noHorizontalScroll(page);
  });
}

test('a 360 px a tela não rola na horizontal (plano, escolha e histórico)', async ({ page }) => {
  const { billing } = await open(page, { width: 360 });
  billing.orders.push({
    id: randomUUID(),
    kind: 'UPGRADE',
    status: 'PAID',
    amountCents: 4321,
    createdAt: new Date().toISOString(),
    paidAt: new Date().toISOString(),
  });
  await page.reload();
  await page.getByRole('tab', { name: 'Planos' }).click();
  await expect(page_(page)).toContainText('Escolher plano');
  await page.getByRole('tab', { name: 'Pagamentos' }).click();
  await expect(page.getByTestId('pedido')).toHaveCount(1);
  await noHorizontalScroll(page);
});

const STATES: {
  name: string;
  sub: Partial<FakeSubscription>;
  title: string;
  text: RegExp;
}[] = [
  {
    name: 'teste gratuito',
    sub: { status: 'TRIAL', endsInDays: 3 },
    title: 'Teste gratuito',
    text: /3 dias restantes/,
  },
  {
    name: 'vencida na carência',
    sub: { status: 'PAST_DUE', access: 'grace', endsInDays: -1 },
    title: 'Assinatura vencida: período de carência',
    text: /continuam funcionando até/,
  },
  {
    name: 'encerrada',
    sub: { status: 'EXPIRED', access: 'blocked', endsInDays: -9 },
    title: 'Assinatura encerrada',
    text: /nada foi apagado/,
  },
  {
    name: 'cancelada para o fim do período',
    sub: { cancelAtPeriodEnd: true },
    title: 'Assinatura cancelada',
    text: /Não será renovada/,
  },
];

for (const theme of ['light', 'dark'] as const) {
  for (const state of STATES) {
    test(`faixa de estado: ${state.name} (tema ${theme})`, async ({ page }) => {
      await open(page, { theme, sub: state.sub });
      await expect(page_(page)).toContainText(state.title);
      await expect(page_(page)).toContainText(state.text);
      await noHorizontalScroll(page);
    });
  }
}

test('cota esgotada: aviso de créditos esgotados com a data em que volta e o caminho para resolver', async ({
  page,
}) => {
  await open(page, {
    billing: { usage: { replies: [2500, 2500], tokens: [10, 15_000_000], milliCents: 0 } },
  });
  await expect(page_(page)).toContainText('Cota do mês esgotada');
  await expect(page_(page)).toContainText('mensagens ficam guardadas e visíveis');
  await expect(page.getByTestId('alerta-respostas')).toContainText('cota deste mês acabou');
  await expect(page.getByTestId('uso-respostas')).toContainText('(100%)');
});

/** Texto visível da área de Assinatura nas três abas (a busca do "token" vale para tudo o que a tela mostra). */
async function visibleTextOfAllTabs(page: Page): Promise<string> {
  const texts: string[] = [];
  for (const tab of ['Resumo', 'Planos', 'Pagamentos']) {
    await page.getByRole('tab', { name: tab }).click();
    texts.push(await page.locator('body').innerText());
  }
  return texts.join(' ');
}

for (const theme of ['light', 'dark'] as const) {
  test(`spec 040 (E2): sem a palavra token, uma barra só, anual com 2 meses grátis e preço por resposta do servidor (tema ${theme})`, async ({
    page,
  }) => {
    const { billing } = await open(page, { theme });
    await expect(page_(page)).toContainText('Assinatura ativa');
    await expect(page_(page).getByRole('progressbar')).toHaveCount(1);
    expect(await visibleTextOfAllTabs(page)).not.toMatch(/token/i);

    // Planos: o preço por resposta vem do catálogo do servidor (Essencial mensal = 1.916 milésimos de centavo).
    await page.getByRole('tab', { name: 'Planos' }).click();
    await expect(page.getByTestId('por-resposta-ESSENTIAL')).toHaveText(
      'equivale a R$ 0,0192 por resposta',
    );
    await expect(page.getByTestId('por-resposta-SCALE')).toHaveText(
      'equivale a R$ 0,0116 por resposta',
    );
    await expect(page.getByLabel(/Anual/)).toBeVisible();
    await expect(page_(page)).toContainText('(um pagamento por ano: 2 meses grátis)');
    await page.getByLabel(/Anual/).check();
    await expect(page.getByTestId('por-resposta-ESSENTIAL')).toHaveText(
      'equivale a R$ 0,0160 por resposta',
    );
    await expect(page.getByTestId('por-resposta-SCALE')).toHaveText(
      'equivale a R$ 0,0097 por resposta',
    );
    await noHorizontalScroll(page);

    // O "servidor" muda o valor e a tela acompanha: o navegador não calcula o preço por resposta.
    billing.perReply = { ESSENTIAL: [1234, 987] };
    await page.reload();
    await page.getByRole('tab', { name: 'Planos' }).click();
    await expect(page.getByTestId('por-resposta-ESSENTIAL')).toHaveText(
      'equivale a R$ 0,0123 por resposta',
    );
    await page.getByLabel(/Anual/).check();
    await expect(page.getByTestId('por-resposta-ESSENTIAL')).toHaveText(
      'equivale a R$ 0,0099 por resposta',
    );
  });
}

test('spec 040 (E2): a 360 px os cartões com o preço por resposta não rolam na horizontal', async ({
  page,
}) => {
  await open(page, { width: 360 });
  await page.getByRole('tab', { name: 'Planos' }).click();
  await expect(page.getByTestId('por-resposta-PROFESSIONAL')).toHaveText(
    'equivale a R$ 0,0150 por resposta',
  );
  await noHorizontalScroll(page);
});

test('spec 040 (E2): o limite de uso da IA esgotado mostra a faixa genérica, sem número e sem a palavra token', async ({
  page,
}) => {
  await open(page, {
    billing: { usage: { replies: [100, 2500], tokens: [15_000_000, 15_000_000], milliCents: 0 } },
  });
  await expect(page_(page)).toContainText(
    'O limite de uso da inteligência artificial deste mês foi atingido',
  );
  await expect(page_(page)).toContainText('nada é perdido');
  await expect(page_(page)).not.toContainText('Cota do mês esgotada');
  // A barra de respostas segue sem alerta (100 de 2.500); nenhum número de tokens aparece.
  await expect(page.getByTestId('alerta-respostas')).toHaveCount(0);
  const text = await visibleTextOfAllTabs(page);
  expect(text).not.toMatch(/token/i);
  expect(text).not.toContain('15.000.000');

  // A faixa do painel (qualquer papel) usa o mesmo texto genérico.
  await page.goto('/painel/conversas');
  await expect(
    page.getByText('O limite de uso da inteligência artificial deste mês foi atingido'),
  ).toBeVisible();
  const panel = await page.locator('body').innerText();
  expect(panel).not.toMatch(/token/i);
  expect(panel).not.toContain('15.000.000');
});

test('escolher plano e ciclo, ver o total do servidor, pagar (abre o link) e voltar: a query só dispara o "Já paguei"', async ({
  page,
}) => {
  const { billing } = await open(page, {
    sub: { status: 'TRIAL', endsInDays: 3, agenda: true, stock: true },
  });
  await page.getByRole('tab', { name: 'Planos' }).click();
  await expect(page.getByTestId('cotacao-texto')).toContainText('Você pagará');
  await page.getByLabel(/Anual/).check();
  await page.getByLabel(/Profissional/).check();
  await page.getByLabel(/Estoque/).uncheck();
  // O total sai da cotação do servidor (nada é calculado no navegador): Profissional anual + Agenda.
  await expect(page.getByTestId('total')).toHaveText('R$ 1.489,00');
  await expect(page.getByTestId('cotacao-texto')).toContainText('Você pagará R$ 1.489,00 agora');
  await page.getByRole('button', { name: 'Pagar', exact: true }).click();
  await page.waitForURL(`${CHECKOUT_HOST}/pay/**`);
  const orders = writes(billing).filter((call) => call.path === '/account/billing/orders');
  expect(orders).toHaveLength(1);
  // Só a escolha vai ao servidor: nenhum preço, desconto nem período.
  expect(orders[0]?.body).toEqual({
    planCode: 'PROFESSIONAL',
    cycle: 'ANNUAL',
    agenda: true,
    stock: false,
  });
  const orderId = billing.created[0] ?? '';

  // Volta do checkout: a query vira "Já paguei" e é tirada da barra; nada de cobrança no armazenamento.
  await page.goto(`/painel/assinatura?order_nsu=${orderId}&transaction_nsu=tx-1&slug=sl-1`);
  await expect(page.getByText('Pagamento confirmado. Seu plano já está ativo.')).toBeVisible();
  await expect(page_(page)).toContainText('Assinatura ativa');
  await expect(page).toHaveURL(/\/painel\/assinatura$/);
  const check = writes(billing).find((call) => call.path.endsWith('/check'));
  expect(check?.body).toEqual({ transactionNsu: 'tx-1', slug: 'sl-1' });
  const stored = await page.evaluate(() =>
    JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
  );
  expect(stored).not.toContain(orderId);
  expect(stored).not.toContain('tx-1');
  expect(await page.title()).not.toContain(orderId);
  await page.getByRole('tab', { name: 'Pagamentos' }).click();
  await expect(page.getByTestId('pedido').first()).toContainText('Pago');
});

test('volta do checkout com pagamento ainda pendente: estado de espera, reconsulta e depois o "Já paguei"', async ({
  page,
}) => {
  const orderId = randomUUID();
  const { billing } = await open(page, {
    sub: { status: 'TRIAL', endsInDays: 3 },
    clock: true,
    path: `/painel/assinatura?order_nsu=${orderId}`,
    billing: {
      checks: ['pending'],
      orders: [
        {
          id: orderId,
          kind: 'NEW',
          status: 'PENDING',
          amountCents: 8800,
          createdAt: new Date().toISOString(),
          paidAt: null,
        },
      ],
    },
  });
  await expect(page.getByTestId('aguardando')).toBeVisible();
  const checks = () => billing.calls.filter((call) => call.path.endsWith('/check')).length;
  await expect.poll(checks).toBeGreaterThan(0);
  const before = checks();
  // O pagamento é confirmado no provedor: a reconsulta seguinte concede.
  billing.checks = ['paid'];
  await page.clock.fastForward(6_000);
  await expect.poll(checks).toBeGreaterThan(before);
  await expect(page.getByText('Pagamento confirmado. Seu plano já está ativo.')).toBeVisible();
  await expect(page.getByTestId('aguardando')).toHaveCount(0);
});

test('pedido pendente no histórico tem "Já paguei"; ainda não confirmado mostra aviso e depois confirma', async ({
  page,
}) => {
  const orderId = randomUUID();
  const { billing } = await open(page, {
    billing: {
      checks: ['pending', 'paid'],
      orders: [
        {
          id: orderId,
          kind: 'RENEWAL',
          status: 'PENDING',
          amountCents: 8800,
          createdAt: new Date().toISOString(),
          paidAt: null,
        },
      ],
    },
  });
  await page.getByRole('tab', { name: 'Pagamentos' }).click();
  const row = page.getByTestId('pedido').first();
  await expect(row).toContainText('Aguardando pagamento');
  await row.getByRole('button', { name: 'Já paguei' }).click();
  await expect(page.getByText(/Ainda não recebemos a confirmação deste pagamento/)).toBeVisible();
  await page.getByTestId('pedido').first().getByRole('button', { name: 'Já paguei' }).click();
  await expect(page.getByText('Pagamento confirmado. Seu plano já está ativo.')).toBeVisible();
  expect(billing.calls.filter((call) => call.path.endsWith('/check'))).toHaveLength(2);
});

test('upgrade: a cotação do servidor aparece antes de confirmar ("você pagará R$ X agora") e o pedido é de diferença', async ({
  page,
}) => {
  const { billing } = await open(page, { sub: { endsInDays: 10 } });
  await page.getByRole('tab', { name: 'Planos' }).click();
  await page.getByLabel(/Profissional/).check();
  await expect(page.getByTestId('cotacao-texto')).toContainText('Você pagará R$ 43,21 agora');
  await expect(page.getByTestId('cotacao-texto')).toContainText('vencimento não muda');
  await page.getByRole('button', { name: 'Pagar a diferença' }).click();
  await page.waitForURL(`${CHECKOUT_HOST}/pay/**`);
  const change = writes(billing).find((call) => call.path === '/account/billing/plan-change');
  expect(change?.body).toEqual({
    action: 'upgrade',
    planCode: 'PROFESSIONAL',
    agenda: true,
    stock: false,
  });
});

test('downgrade vira troca agendada sem cobrança e pode ser desfeita', async ({ page }) => {
  const { billing } = await open(page, { sub: { planCode: 'PROFESSIONAL' } });
  await page.getByRole('tab', { name: 'Planos' }).click();
  await page.getByLabel(/Essencial/).check();
  await expect(page.getByTestId('cotacao-texto')).toContainText('Nada será cobrado agora');
  await page.getByRole('button', { name: 'Agendar troca' }).click();
  await page.getByRole('tab', { name: 'Resumo' }).click();
  const box = page.getByTestId('troca-agendada');
  await expect(box).toContainText('Troca agendada');
  await expect(box).toContainText('Essencial');
  await expect(page.getByText(/Troca agendada para a próxima renovação/)).toBeVisible();
  expect(writes(billing).some((call) => call.path === '/account/billing/orders')).toBe(false);
  await box.getByRole('button', { name: 'Desfazer troca agendada' }).click();
  await expect(page.getByTestId('troca-agendada')).toHaveCount(0);
  expect(billing.sub?.pendingChange).toBeNull();
});

test('cancelar com confirmação (Esc cancela sem confirmar) e reativar antes do fim', async ({
  page,
}) => {
  const { billing } = await open(page);
  const cancel = page.getByRole('button', { name: 'Cancelar assinatura' });
  await cancel.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('não será renovada');
  await expect(dialog).toContainText('Nada é apagado');
  await expect(dialog.getByRole('button', { name: 'Cancelar', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(billing.sub?.cancelAtPeriodEnd).toBe(false);

  await cancel.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancelar assinatura' }).click();
  await expect(page_(page)).toContainText('Assinatura cancelada');
  expect(billing.sub?.cancelAtPeriodEnd).toBe(true);
  await page.getByRole('button', { name: 'Reativar assinatura' }).click();
  await expect(page.getByText(/Assinatura reativada/)).toBeVisible();
  await expect(page_(page)).toContainText('Assinatura ativa');
  expect(billing.sub?.cancelAtPeriodEnd).toBe(false);
});

test('mais empresas do que o plano comporta: mensagem clara por código, botão desligado e nada do texto do servidor', async ({
  page,
}) => {
  await open(page, {
    sub: { planCode: 'PROFESSIONAL', companies: 3 },
    billing: { quoteError: { status: 409, code: 'PLAN_DOWNGRADE_BLOCKED' } },
  });
  await page.getByRole('tab', { name: 'Planos' }).click();
  await page.getByLabel(/Essencial/).check();
  await expect(page.getByTestId('cotacao')).toContainText(
    'Você tem mais empresas do que este plano comporta',
  );
  await expect(page.getByRole('button', { name: 'Continuar' })).toBeDisabled();
  await expect(page.locator('body')).not.toContainText(SENTINEL);
});

test('erro ao criar o pedido usa o code: mensagem do site, nunca o texto do servidor', async ({
  page,
}) => {
  const { billing } = await open(page, {
    sub: { status: 'EXPIRED', access: 'blocked', endsInDays: -9 },
  });
  await page.getByRole('tab', { name: 'Planos' }).click();
  await expect(page.getByTestId('cotacao-texto')).toContainText('Você pagará');
  await page.route('**/api/account/billing/orders', (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: 'ORDER_LIMIT_REACHED', message: SENTINEL, requestId: 'x' } },
    }),
  );
  await page.getByRole('button', { name: 'Pagar', exact: true }).click();
  await expect(
    page.getByText('Você já criou muitos pedidos hoje. Tente novamente amanhã.'),
  ).toBeVisible();
  await expect(page.locator('body')).not.toContainText(SENTINEL);
  expect(billing.created).toHaveLength(0);
});

test('quem não é titular (entrou por convite) não vê o item no menu; forçar o endereço não mostra preço nem botão e não escreve', async ({
  page,
}) => {
  const { billing } = await open(page, { billing: { sub: null } });
  await expect(page.getByRole('link', { name: 'Assinatura', exact: true })).toHaveCount(0);
  await expect(page.getByText(/não tem assinatura própria/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Pagar|Renovar|Cancelar assinatura/ })).toHaveCount(
    0,
  );
  await expect(page.locator('body')).not.toContainText('R$');
  expect(writes(billing)).toEqual([]);
  expect(billing.calls.some((call) => call.path.startsWith('/account/billing/quote'))).toBe(false);
});

test('com a cobrança desligada o menu não tem Assinatura e o endereço avisa que não está habilitada', async ({
  page,
}) => {
  await open(page, { billing: { enabled: false } });
  await expect(page.getByText(/não tem assinatura própria|não está habilitada/)).toBeVisible();
  expect((await menuItems(page)).includes('Assinatura')).toBe(false);
});

test('sem checkout ligado a tela mostra plano e uso mas não oferece pagar nem trocar', async ({
  page,
}) => {
  const { billing } = await open(page, { billing: { checkoutEnabled: false } });
  await expect(page_(page)).toContainText('Seu plano');
  await page.getByRole('tab', { name: 'Planos' }).click();
  await expect(page_(page)).toContainText('pagamento ainda não está habilitado');
  await expect(page.getByRole('button', { name: /Pagar|Renovar/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancelar assinatura' })).toHaveCount(0);
  expect(writes(billing)).toEqual([]);
});

test('sem a Agenda contratada: a aba some, forçar o endereço mostra "não contratado" e nenhuma chamada da agenda é feita', async ({
  page,
}) => {
  const { api, billing } = await open(page, {
    full: true,
    sub: { agenda: false, stock: true },
    path: '/painel/agenda',
  });
  await expect(page.getByTestId('modulo-nao-contratado')).toContainText('Agenda não contratado');
  await expect(page.getByRole('button', { name: 'Contratar na Assinatura' })).toBeVisible();
  const labels = await menuItems(page);
  expect(labels).not.toContain('Agenda');
  expect(api.calls.some((call) => call.path.includes('/schedule'))).toBe(false);
  expect(writes(billing)).toEqual([]);
  await page.getByRole('button', { name: 'Contratar na Assinatura' }).click();
  await expect(page).toHaveURL(/\/painel\/assinatura$/);
});

test('faixa de carência e de encerramento para qualquer papel, com o caminho certo; a leitura continua', async ({
  page,
}) => {
  await open(page, {
    role: 'AGENT',
    path: '/painel/conversas',
    billing: {
      sub: null,
      access: { access: 'blocked', agenda: true, stock: true },
    },
  });
  await expect(page.getByText('Assinatura encerrada')).toBeVisible();
  await expect(page.getByText(/pessoa titular da conta/)).toBeVisible();
  // A tela de conversas segue carregando (leitura continua funcionando).
  await expect(page.getByRole('heading', { level: 1, name: 'Conversas' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Abrir Assinatura' })).toHaveCount(0);
});

test('o titular vê o botão para abrir a Assinatura na faixa de carência', async ({ page }) => {
  await open(page, {
    path: '/painel/conversas',
    sub: { status: 'PAST_DUE', access: 'grace', endsInDays: -1 },
  });
  await expect(page.getByText('Assinatura vencida')).toBeVisible();
  await page.getByRole('button', { name: 'Abrir Assinatura' }).click();
  await expect(page).toHaveURL(/\/painel\/assinatura$/);
});

test('assistente de primeiros passos: o passo de Serviços sem Agenda convida a contratar e o do WhatsApp avisa que o plano não inclui a Meta', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('soprei-theme', 'light'));
  const api = await installApi(page, { role: 'OWNER' });
  const onb = newOnboarding();
  await installOnboardingApi(page, api, onb, 'OWNER');
  for (const item of api.companies) item.permissions = ONBOARDING_PERMISSIONS.OWNER;
  const billing = newBilling({ sub: { ...newBilling().sub!, agenda: false, stock: true } });
  await installBillingApi(page, api, billing);
  await page.goto('/painel/primeiros-passos/servicos');
  await expect(page.getByTestId('modulo-nao-contratado')).toContainText('Agenda não contratado');
  await expect(page.getByRole('button', { name: 'Contratar na Assinatura' })).toBeVisible();
  await page.goto('/painel/primeiros-passos/testar');
  await expect(page.getByTestId('aviso-whatsapp')).toContainText(
    'não inclui o custo das mensagens',
  );
});

test('o login da conta titular com a assinatura encerrada abre a Assinatura (e com a assinatura em dia abre as Conversas)', async ({
  page,
}) => {
  await open(page, {
    path: '/entrar',
    sub: { status: 'EXPIRED', access: 'blocked', endsInDays: -9 },
  });
  await expect(page).toHaveURL(/\/painel\/assinatura$/);
  await expect(page_(page)).toContainText('Assinatura encerrada');
});

test('o login da conta titular com a assinatura em dia segue para as Conversas', async ({
  page,
}) => {
  await open(page, { path: '/entrar' });
  await expect(page).toHaveURL(/\/painel\/conversas$/);
});

test('conta com assinatura própria que é membro da empresa de OUTRA conta: sem item Assinatura, a faixa manda falar com o titular e a tela não é oferecida', async ({
  page,
}) => {
  const { billing } = await open(page, {
    path: '/painel/conversas',
    billing: { holder: false, access: { access: 'blocked', agenda: true, stock: true } },
  });
  await expect(page.getByText('Assinatura encerrada')).toBeVisible();
  await expect(page.getByText(/pessoa titular da conta/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Abrir Assinatura' })).toHaveCount(0);
  expect((await menuItems(page)).includes('Assinatura')).toBe(false);
  // Forçar o endereço: nada da assinatura da conta logada é mostrado nem lido.
  await page.goto('/painel/assinatura');
  await expect(page.getByText(/não tem assinatura própria/)).toBeVisible();
  await expect(page.locator('body')).not.toContainText('R$');
  expect(billing.calls.some((call) => call.path === '/account/billing')).toBe(false);
});
