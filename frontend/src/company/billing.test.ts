import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { pageForPath, pathForPage } from '../account-flow';
import { ApiError } from '../api';
import {
  billingFailure,
  billingSchema,
  entitlementsSchema,
  type Billing,
  type Entitlements,
  type Quote,
  type Subscription,
} from './billing-api';
import {
  accessNotice,
  AI_LIMIT_TITLE,
  canCancel,
  canCheckOrder,
  canReactivate,
  CYCLE_NOTES,
  daysLeft,
  defaultSelection,
  exhaustedBanner,
  formatDate,
  hasModule,
  metaEstimateCents,
  moduleOfPage,
  parseCheckoutReturn,
  perReplyText,
  quotaLevel,
  quotaReason,
  quoteView,
  safeCheckoutUrl,
  samePlan,
  stateBanner,
  usagePercent,
  whatsappNotice,
  WHATSAPP_NOT_INCLUDED,
} from './billing-rules';
import {
  allowedPages,
  AREA_PAGES,
  areaPageForPath,
  BILLING_PERMISSION,
  canOpen,
} from './company-nav';

const NOW = new Date('2026-11-10T12:00:00Z');
const UUID = '0190a3b4-1111-4222-8333-444455556666';

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    planCode: 'ESSENTIAL',
    planName: 'Essencial',
    cycle: 'MONTHLY',
    agenda: true,
    stock: false,
    status: 'ACTIVE',
    access: 'ok',
    currentPeriodStart: '2026-10-20T12:00:00.000Z',
    currentPeriodEnd: '2026-11-20T12:00:00.000Z',
    graceEndsAt: '2026-11-25T12:00:00.000Z',
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    pendingChange: null,
    maxCompanies: 1,
    companies: 1,
    whatsappBillingMode: 'CUSTOMER_PAYS_META',
    whatsappNotice: 'NOT_INCLUDED',
    ...overrides,
  };
}

function billing(overrides: Partial<Billing> = {}): Billing {
  return {
    subscription: subscription(),
    usage: null,
    orders: [],
    catalog: [
      {
        code: 'ESSENTIAL',
        name: 'Essencial',
        maxCompanies: 1,
        monthlyTokens: 3_000_000,
        monthlyReplies: 800,
        prices: [
          {
            cycle: 'MONTHLY',
            baseCents: 5900,
            agendaCents: 2900,
            stockCents: 1900,
            whatsappBillingMode: 'CUSTOMER_PAYS_META',
          },
        ],
      },
    ],
    trial: { available: false, days: 7 },
    checkoutEnabled: true,
    checkoutHost: null,
    ...overrides,
  };
}

test('datas em dd/MM/aaaa no fuso do Brasil e dias restantes arredondados para cima', () => {
  assert.equal(formatDate('2026-12-01T12:00:00.000Z'), '01/12/2026');
  assert.equal(formatDate('2026-12-01T02:30:00.000Z'), '30/11/2026');
  assert.equal(daysLeft('2026-11-17T12:00:00.000Z', NOW), 7);
  assert.equal(daysLeft('2026-11-10T12:00:01.000Z', NOW), 1);
  assert.equal(daysLeft('2026-11-01T12:00:00.000Z', NOW), 0);
});

test('porcentagem de uso e níveis de alerta: 80% é atenção, 100% é cota esgotada', () => {
  assert.equal(usagePercent(0, 800), 0);
  assert.equal(usagePercent(639, 800), 79);
  assert.equal(usagePercent(640, 800), 80);
  assert.equal(usagePercent(900, 800), 100);
  assert.equal(usagePercent(5, 0), 0);
  assert.equal(quotaLevel(639, 800), 'ok');
  assert.equal(quotaLevel(640, 800), 'warn');
  assert.equal(quotaLevel(799, 800), 'warn');
  assert.equal(quotaLevel(800, 800), 'full');
  assert.equal(quotaLevel(1, 0), 'ok');
});

test('a estimativa da Meta (milésimos de centavo do servidor) vira centavos só para exibir', () => {
  assert.equal(metaEstimateCents(0), 0);
  assert.equal(metaEstimateCents(3_500 * 120), 420);
  assert.equal(metaEstimateCents(-5), 0);
});

test('faixa de estado: texto para cada estado, com a carência e o que acontece depois', () => {
  const trial = stateBanner(
    subscription({ status: 'TRIAL', trialEndsAt: '2026-11-13T12:00:00.000Z' }),
    NOW,
  );
  assert.equal(trial.tone, 'info');
  assert.match(trial.text, /3 dias restantes/);
  assert.match(trial.text, /13\/11\/2026/);
  assert.equal(stateBanner(subscription(), NOW).tone, 'success');
  const pastDue = stateBanner(subscription({ status: 'PAST_DUE', access: 'grace' }), NOW);
  assert.equal(pastDue.tone, 'warning');
  assert.match(pastDue.text, /25\/11\/2026/);
  const expired = stateBanner(subscription({ status: 'EXPIRED', access: 'blocked' }), NOW);
  assert.equal(expired.tone, 'error');
  assert.match(expired.text, /nada foi apagado/);
  const cancelled = stateBanner(
    subscription({ status: 'CANCELLED', cancelAtPeriodEnd: true }),
    NOW,
  );
  assert.match(cancelled.text, /Não será renovada/);
  assert.match(cancelled.text, /20\/11\/2026/);
});

test('cancelar só com plano pago em vigor; reativar só se marcada para cancelar e ainda não encerrada', () => {
  assert.equal(canCancel(subscription()), true);
  assert.equal(canCancel(subscription({ status: 'TRIAL' })), false);
  assert.equal(canCancel(subscription({ status: 'EXPIRED' })), false);
  assert.equal(canCancel(subscription({ cancelAtPeriodEnd: true })), false);
  assert.equal(canReactivate(subscription({ cancelAtPeriodEnd: true })), true);
  assert.equal(canReactivate(subscription({ cancelAtPeriodEnd: true, access: 'blocked' })), false);
  assert.equal(canReactivate(subscription()), false);
});

test('a cotação do servidor decide o botão e o texto: o navegador não calcula valor', () => {
  const base: Quote = {
    kind: 'NEW',
    amountCents: 8800,
    effective: 'now',
    periodEnd: null,
    remainingDays: null,
  };
  assert.deepEqual(
    { action: quoteView(base, NOW).action, button: quoteView(base, NOW).button },
    { action: 'pay', button: 'Pagar' },
  );
  assert.match(quoteView(base, NOW).text, /Você pagará R\$ 88,00 agora/);
  const upgrade = quoteView(
    {
      kind: 'UPGRADE',
      amountCents: 4321,
      effective: 'now',
      periodEnd: '2026-11-20T12:00:00.000Z',
      remainingDays: 10,
    },
    NOW,
  );
  assert.equal(upgrade.action, 'upgrade');
  assert.match(upgrade.text, /Você pagará R\$ 43,21 agora/);
  assert.match(upgrade.text, /10 dias restantes/);
  assert.match(upgrade.text, /vencimento não muda/);
  const down = quoteView(
    {
      kind: 'DOWNGRADE',
      amountCents: 0,
      effective: 'next_renewal',
      periodEnd: '2026-11-20T12:00:00.000Z',
      remainingDays: null,
    },
    NOW,
  );
  assert.equal(down.action, 'schedule');
  assert.match(down.text, /Nada será cobrado agora/);
  assert.match(down.text, /20\/11\/2026/);
  assert.equal(quoteView({ ...base, kind: 'RENEWAL' }, NOW).button, 'Renovar');
});

test('escolha inicial é a assinatura atual; sem assinatura, o primeiro plano mensal sem módulos', () => {
  assert.deepEqual(defaultSelection(billing()), {
    planCode: 'ESSENTIAL',
    cycle: 'MONTHLY',
    agenda: true,
    stock: false,
  });
  assert.deepEqual(defaultSelection(billing({ subscription: null })), {
    planCode: 'ESSENTIAL',
    cycle: 'MONTHLY',
    agenda: false,
    stock: false,
  });
  const a = defaultSelection(billing());
  assert.equal(samePlan(a, { ...a }), true);
  assert.equal(samePlan(a, { ...a, stock: true }), false);
});

test('volta do checkout: só order_nsu em UUID vale; referências fora do formato são descartadas', () => {
  const ok = parseCheckoutReturn(
    `?order_nsu=${UUID.toUpperCase()}&transaction_nsu=abc-123&slug=s_1&receipt_url=https://x.test`,
  );
  assert.deepEqual(ok, { orderId: UUID, transactionNsu: 'abc-123', slug: 's_1' });
  assert.equal(parseCheckoutReturn('?order_nsu=nao-e-uuid'), null);
  assert.equal(parseCheckoutReturn(''), null);
  assert.deepEqual(parseCheckoutReturn(`?order_nsu=${UUID}&slug=<script>`), { orderId: UUID });
});

test('o link do checkout só abre com https e sem credenciais embutidas', () => {
  assert.equal(
    safeCheckoutUrl('https://checkout.example.test/pay/abc'),
    'https://checkout.example.test/pay/abc',
  );
  assert.equal(safeCheckoutUrl('http://checkout.example.test/pay'), null);
  assert.equal(safeCheckoutUrl('javascript:alert(1)'), null);
  assert.equal(safeCheckoutUrl('https://user:senha@checkout.example.test/'), null);
  assert.equal(safeCheckoutUrl('nao é url'), null);
  // Com o host do provedor informado pelo servidor, só esse host abre (defesa em profundidade).
  assert.notEqual(
    safeCheckoutUrl('https://checkout.example.test/p', 'checkout.example.test'),
    null,
  );
  assert.equal(safeCheckoutUrl('https://outro.example.test/p', 'checkout.example.test'), null);
  assert.equal(
    safeCheckoutUrl('https://checkout.example.test.mau.test/p', 'checkout.example.test'),
    null,
  );
});

test('pedido pendente só pode ser confirmado dentro das 24 h de validade', () => {
  const order = {
    id: UUID,
    kind: 'NEW' as const,
    status: 'PENDING' as const,
    amountCents: 100,
    createdAt: '2026-11-10T00:00:00.000Z',
    paidAt: null,
  };
  assert.equal(canCheckOrder(order, NOW), true);
  assert.equal(canCheckOrder({ ...order, createdAt: '2026-11-08T00:00:00.000Z' }, NOW), false);
  assert.equal(canCheckOrder({ ...order, status: 'PAID' }, NOW), false);
});

test('aviso fixo do modo vigente: o plano não inclui o custo da Meta (modo C) ou inclui até N respostas (modo S)', () => {
  assert.equal(whatsappNotice('NOT_INCLUDED', 800), WHATSAPP_NOT_INCLUDED);
  assert.match(WHATSAPP_NOT_INCLUDED, /não inclui o custo das mensagens do WhatsApp/);
  assert.match(WHATSAPP_NOT_INCLUDED, /Meta cobra direto/);
  assert.match(whatsappNotice('INCLUDED_UP_TO_REPLIES', 500), /até 500 respostas/);
});

test('mensagens de erro vêm do status e do code; o texto do servidor nunca é usado', () => {
  const sentinel = 'TEXTO-DO-SERVIDOR';
  const failure = (status: number, code?: string) =>
    billingFailure(new ApiError(status, sentinel, code));
  assert.deepEqual(failure(401), { kind: 'session' });
  assert.deepEqual(failure(404), { kind: 'disabled' });
  const blocked = failure(409, 'PLAN_DOWNGRADE_BLOCKED');
  assert.equal(blocked.kind, 'message');
  assert.match(
    blocked.kind === 'message' ? blocked.text : '',
    /mais empresas do que este plano comporta/,
  );
  for (const status of [400, 403, 409, 429, 500, 502, 503]) {
    for (const code of [undefined, 'PLAN_CHANGE_UNAVAILABLE', 'CODIGO_QUALQUER']) {
      const result = failure(status, code);
      assert.ok(result.kind !== 'message' || !result.text.includes(sentinel));
    }
  }
  assert.equal(billingFailure(new Error('x')).kind, 'message');
});

test('o contrato da cobrança recusa o que não tem o formato esperado', () => {
  const valid = {
    subscription: null,
    usage: null,
    orders: [],
    catalog: [],
    trial: { available: true, days: 7 },
    checkoutEnabled: false,
  };
  assert.ok(billingSchema.safeParse(valid).success);
  assert.ok(!billingSchema.safeParse({ ...valid, checkoutEnabled: 'sim' }).success);
  assert.ok(
    !billingSchema.safeParse({
      ...valid,
      orders: [
        { id: 'x', kind: 'NEW', status: 'PAID', amountCents: -1, createdAt: 'ontem', paidAt: null },
      ],
    }).success,
  );
});

test('faixa de acesso para qualquer papel: carência, encerrada e cota esgotada, com o caminho certo', () => {
  const ok: Entitlements = {
    access: 'ok',
    agenda: true,
    stock: true,
    tokens: { used: 10, limit: 100 },
    replies: { used: 10, limit: 100 },
    holder: true,
  };
  assert.equal(accessNotice(null, true), null);
  assert.equal(accessNotice(ok, true), null);
  const blocked = accessNotice({ ...ok, access: 'blocked' }, false);
  assert.equal(blocked?.tone, 'error');
  assert.match(blocked?.text ?? '', /pessoa titular da conta/);
  const grace = accessNotice({ ...ok, access: 'grace' }, true);
  assert.equal(grace?.tone, 'warning');
  assert.match(grace?.text ?? '', /tela de Assinatura/);
  const full = accessNotice({ ...ok, replies: { used: 100, limit: 100 } }, true);
  assert.match(full?.title ?? '', /Respostas do mês esgotadas/);
  const ai = accessNotice({ ...ok, tokens: { used: 100, limit: 100 } }, true);
  assert.equal(ai?.title, 'O limite de uso da inteligência artificial deste mês foi atingido');
  // Os dois contratos: o acesso da empresa não carrega dinheiro.
  assert.ok(entitlementsSchema.safeParse(ok).success);
  // O titular vem do servidor; sem o campo vale como não titular (nunca oferece a tela por engano).
  const withoutHolder = { ...ok, holder: undefined };
  assert.equal(entitlementsSchema.parse(withoutHolder).holder, false);
});

test('abas de Agenda e Estoque dependem do módulo; sem a leitura do acesso nada some', () => {
  assert.equal(moduleOfPage('agenda'), 'agenda');
  assert.equal(moduleOfPage('agendaConfig'), 'agenda');
  assert.equal(moduleOfPage('estoque'), 'stock');
  assert.equal(moduleOfPage('conhecimento'), null);
  const none: Entitlements = {
    access: 'ok',
    agenda: false,
    stock: false,
    tokens: null,
    replies: null,
    holder: false,
  };
  assert.equal(hasModule(null, 'agenda'), true);
  assert.equal(hasModule(none, 'agenda'), false);
  assert.equal(hasModule({ ...none, stock: true }, 'stock'), true);
});

test('a aba Assinatura só aparece com a permissão de conta, fica antes de Primeiros passos e tem endereço próprio', () => {
  const owner = ['conversation:read', 'conversation:simulate', 'onboarding:manage'];
  assert.ok(!allowedPages(owner).includes('assinatura'));
  const holder = [...owner, BILLING_PERMISSION];
  assert.ok(allowedPages(holder).includes('assinatura'));
  assert.equal(canOpen('assinatura', owner), false);
  assert.equal(canOpen('assinatura', holder), true);
  const order = [...AREA_PAGES];
  assert.equal(order.at(-1), 'primeirosPassos');
  assert.equal(order.indexOf('assinatura'), order.length - 2);
  assert.equal(areaPageForPath('/painel/assinatura'), 'assinatura');
  assert.equal(pageForPath('/painel/assinatura'), 'assinatura');
  assert.equal(pathForPage('assinatura'), '/painel/assinatura');
});

test('nenhum texto da tela usa o termo antigo da empresa', () => {
  const sample = [
    stateBanner(subscription({ status: 'EXPIRED', access: 'blocked' }), NOW).text,
    WHATSAPP_NOT_INCLUDED,
    accessNotice(
      { access: 'blocked', agenda: true, stock: true, tokens: null, replies: null, holder: true },
      true,
    )?.text ?? '',
  ].join(' ');
  assert.ok(!/clien/i.test(sample));
});

test('spec 040 (E2): o limite de uso da IA esgotado tem texto genérico, sem número nem a palavra token', () => {
  const ok: Entitlements = {
    access: 'ok',
    agenda: true,
    stock: true,
    tokens: { used: 14_999_999, limit: 15_000_000 },
    replies: { used: 2_499, limit: 2_500 },
    holder: true,
  };
  assert.equal(quotaReason(ok.replies, ok.tokens), null);
  // Por tokens: título fixo, sem número; a mesma explicação (nada se perde, quando volta, como resolver).
  for (const holder of [true, false]) {
    const ai = accessNotice({ ...ok, tokens: { used: 15_000_000, limit: 15_000_000 } }, holder);
    assert.equal(ai?.tone, 'error');
    assert.equal(ai?.title, AI_LIMIT_TITLE);
    assert.equal(
      AI_LIMIT_TITLE,
      'O limite de uso da inteligência artificial deste mês foi atingido',
    );
    const all = `${ai?.title ?? ''} ${ai?.text ?? ''}`;
    assert.ok(!/\d/.test(all), all);
    assert.ok(!/token/i.test(all), all);
    assert.match(all, /mensagens ficam guardadas/);
    assert.match(all, /próximo mês/);
  }
  // Por respostas: mantém o texto das respostas (e vale ele se as duas acabaram).
  const replies = accessNotice({ ...ok, replies: { used: 2_500, limit: 2_500 } }, true);
  assert.equal(replies?.title, 'Respostas do mês esgotadas');
  const both = accessNotice(
    {
      ...ok,
      replies: { used: 2_500, limit: 2_500 },
      tokens: { used: 15_000_000, limit: 15_000_000 },
    },
    true,
  );
  assert.equal(both?.title, 'Respostas do mês esgotadas');
  assert.equal(quotaReason(null, null), null);
});

test('spec 040 (E2): a faixa da tela de Assinatura com a cota esgotada traz a data de volta e nenhum número de tokens', () => {
  const usage = (repliesUsed: number, tokensUsed: number): NonNullable<Billing['usage']> => ({
    windowStart: '2026-11-01T03:00:00.000Z',
    windowEnd: '2026-12-01T03:00:00.000Z',
    replies: { used: repliesUsed, limit: 2_500 },
    tokens: { used: tokensUsed, limit: 15_000_000 },
    metaEstimate: { isEstimate: true, milliCents: 0 },
  });
  assert.equal(exhaustedBanner(null), null);
  assert.equal(exhaustedBanner(usage(10, 10)), null);
  const replies = exhaustedBanner(usage(2_500, 10));
  assert.equal(replies?.title, 'Cota do mês esgotada');
  assert.match(replies?.text ?? '', /01\/12\/2026/);
  const ai = exhaustedBanner(usage(10, 15_000_000));
  assert.equal(ai?.title, AI_LIMIT_TITLE);
  assert.match(ai?.text ?? '', /nada é perdido/);
  assert.match(ai?.text ?? '', /01\/12\/2026/);
  const all = `${ai?.title ?? ''} ${ai?.text ?? ''}`;
  assert.ok(!/token/i.test(all));
  // Além da data de volta, nenhum número (nem de tokens nem de uso).
  assert.ok(!/\d/.test(all.replace('01/12/2026', '')), all);
});

test('spec 040 (E2): preço por resposta só formata o valor do servidor; anual com "2 meses grátis"', () => {
  assert.equal(perReplyText(1_916), 'equivale a R$ 0,0192 por resposta');
  assert.equal(perReplyText(1_596), 'equivale a R$ 0,0160 por resposta');
  assert.equal(perReplyText(1_498), 'equivale a R$ 0,0150 por resposta');
  assert.equal(perReplyText(1_248), 'equivale a R$ 0,0125 por resposta');
  assert.equal(perReplyText(1_163), 'equivale a R$ 0,0116 por resposta');
  assert.equal(perReplyText(969), 'equivale a R$ 0,0097 por resposta');
  // Ausente (servidor anterior) ou 0 (cota inválida): a linha não aparece.
  assert.equal(perReplyText(undefined), null);
  assert.equal(perReplyText(0), null);
  assert.equal(CYCLE_NOTES.ANNUAL, ' (um pagamento por ano: 2 meses grátis)');
  assert.equal(CYCLE_NOTES.MONTHLY, '');
  // O contrato aceita o campo novo e continua aceitando o catálogo sem ele (compatível com rollback).
  const plan = {
    code: 'ESSENTIAL',
    name: 'Essencial',
    maxCompanies: 1,
    monthlyTokens: 15_000_000,
    monthlyReplies: 2_500,
    prices: [
      {
        cycle: 'MONTHLY',
        baseCents: 4_790,
        agendaCents: 2_900,
        stockCents: 1_900,
        whatsappBillingMode: 'CUSTOMER_PAYS_META',
        perReplyMilliCents: 1_916,
      },
    ],
  };
  const base = {
    subscription: null,
    usage: null,
    orders: [],
    trial: { available: true, days: 7 },
    checkoutEnabled: true,
  };
  const parsed = billingSchema.parse({ ...base, catalog: [plan] });
  assert.equal(parsed.catalog[0]?.prices[0]?.perReplyMilliCents, 1_916);
  const withoutField = {
    cycle: 'MONTHLY',
    baseCents: 4_790,
    agendaCents: 2_900,
    stockCents: 1_900,
    whatsappBillingMode: 'CUSTOMER_PAYS_META',
  };
  assert.ok(
    billingSchema.safeParse({ ...base, catalog: [{ ...plan, prices: [withoutField] }] }).success,
  );
  assert.ok(
    !billingSchema.safeParse({
      ...base,
      catalog: [{ ...plan, prices: [{ ...plan.prices[0], perReplyMilliCents: -1 }] }],
    }).success,
  );
});
