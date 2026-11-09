import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addMonthsUtc,
  buildEntitlements,
  classifyChange,
  computePaidPeriod,
  prorateUpgradeCents,
  subscriptionWindows,
  windowsInSpan,
  metaEstimateMilliCents,
  priceTotalCents,
  quotaBlockReason,
  quotaLimits,
  reachedAlertFractions,
  resolveAccess,
  type SubscriptionRecord,
  type SubscriptionStatus,
  TOKENS_PER_EXTRA_REPLY,
  usageWindowEnd,
  usageWindowStart,
  windowsInPeriod,
} from './billing.js';

const DAY = 86_400_000;
const GRACE = 5;
const iso = (value: Date): string => value.toISOString();
const at = (value: string): Date => new Date(value);

const PLAN = {
  id: 'p',
  code: 'ESSENTIAL',
  name: 'Essencial',
  maxCompanies: 1,
  monthlyTokens: 3_000_000,
  monthlyReplies: 800,
  metaEstimateMilliCents: 3_500,
  version: 1,
} as const;

function subscription(
  status: SubscriptionStatus,
  overrides: Partial<SubscriptionRecord> = {},
): SubscriptionRecord {
  return {
    id: 's',
    accountId: 'a',
    plan: PLAN,
    price: {
      id: 'pr',
      cycle: 'MONTHLY',
      baseCents: 5_900,
      agendaCents: 2_900,
      stockCents: 1_900,
      whatsappBillingMode: 'CUSTOMER_PAYS_META',
      metaPerReplyMilliCents: 3_500,
      extraPackCents: 5_900,
      extraPackReplies: 500,
      version: 1,
      validFrom: at('2026-11-01T00:00:00Z'),
    },
    cycle: 'MONTHLY',
    agendaEnabled: true,
    stockEnabled: false,
    status,
    currentPeriodStart: at('2026-11-01T00:00:00Z'),
    currentPeriodEnd: at('2026-12-01T00:00:00Z'),
    trialEndsAt: status === 'TRIAL' ? at('2026-11-08T00:00:00Z') : null,
    cancelAtPeriodEnd: false,
    pendingChange: null,
    ...overrides,
  };
}

describe('resolveAccess (spec 031): estado efetivo derivado do tempo', () => {
  it('TRIAL: ok antes de trialEndsAt; no instante exato e depois, bloqueado (EXPIRED)', () => {
    const trial = subscription('TRIAL');
    assert.deepEqual(resolveAccess(trial, at('2026-11-07T23:59:59.999Z'), GRACE), {
      state: 'TRIAL',
      access: 'ok',
    });
    assert.deepEqual(resolveAccess(trial, at('2026-11-08T00:00:00Z'), GRACE), {
      state: 'EXPIRED',
      access: 'blocked',
    });
    assert.deepEqual(resolveAccess(trial, at('2027-01-01T00:00:00Z'), GRACE), {
      state: 'EXPIRED',
      access: 'blocked',
    });
  });

  it('ACTIVE: ok no período; no instante do vencimento entra a carência; no fim da carência, bloqueia', () => {
    const active = subscription('ACTIVE');
    const end = active.currentPeriodEnd.getTime();
    assert.deepEqual(resolveAccess(active, new Date(end - 1), GRACE), {
      state: 'ACTIVE',
      access: 'ok',
    });
    assert.deepEqual(resolveAccess(active, new Date(end), GRACE), {
      state: 'PAST_DUE',
      access: 'grace',
    });
    assert.deepEqual(resolveAccess(active, new Date(end + GRACE * DAY - 1), GRACE), {
      state: 'PAST_DUE',
      access: 'grace',
    });
    assert.deepEqual(resolveAccess(active, new Date(end + GRACE * DAY), GRACE), {
      state: 'EXPIRED',
      access: 'blocked',
    });
  });

  it('PAST_DUE guardado segue as mesmas regras de tempo da ACTIVE', () => {
    const pastDue = subscription('PAST_DUE');
    const end = pastDue.currentPeriodEnd.getTime();
    assert.equal(resolveAccess(pastDue, new Date(end + DAY), GRACE).access, 'grace');
    assert.equal(resolveAccess(pastDue, new Date(end + 6 * DAY), GRACE).access, 'blocked');
  });

  it('CANCELLED vale até o fim do período, sem carência; depois EXPIRED', () => {
    const cancelled = subscription('CANCELLED');
    const end = cancelled.currentPeriodEnd.getTime();
    assert.deepEqual(resolveAccess(cancelled, new Date(end - 1), GRACE), {
      state: 'CANCELLED',
      access: 'ok',
    });
    assert.deepEqual(resolveAccess(cancelled, new Date(end), GRACE), {
      state: 'EXPIRED',
      access: 'blocked',
    });
  });

  it('ACTIVE com cancelAtPeriodEnd aparece como CANCELLED e não ganha carência', () => {
    const marked = subscription('ACTIVE', { cancelAtPeriodEnd: true });
    const end = marked.currentPeriodEnd.getTime();
    assert.equal(resolveAccess(marked, new Date(end - 1), GRACE).state, 'CANCELLED');
    assert.equal(resolveAccess(marked, new Date(end), GRACE).access, 'blocked');
  });

  it('EXPIRED é sempre bloqueado; carência de 0 dias bloqueia no vencimento', () => {
    assert.equal(
      resolveAccess(subscription('EXPIRED'), at('2026-11-02T00:00:00Z'), GRACE).access,
      'blocked',
    );
    const active = subscription('ACTIVE');
    assert.equal(resolveAccess(active, active.currentPeriodEnd, 0).access, 'blocked');
  });
});

describe('addMonthsUtc e usageWindowStart (spec 031): janelas ancoradas no período pago', () => {
  it('soma meses mantendo a hora e levando o dia 31 ao último dia do mês curto (sempre a partir da âncora)', () => {
    const anchor = at('2026-01-31T13:45:00Z');
    assert.equal(iso(addMonthsUtc(anchor, 1)), '2026-02-28T13:45:00.000Z');
    assert.equal(iso(addMonthsUtc(anchor, 2)), '2026-03-31T13:45:00.000Z');
    assert.equal(iso(addMonthsUtc(anchor, 3)), '2026-04-30T13:45:00.000Z');
    // Ano bissexto.
    assert.equal(iso(addMonthsUtc(at('2028-01-31T00:00:00Z'), 1)), '2028-02-29T00:00:00.000Z');
    assert.equal(iso(addMonthsUtc(anchor, 12)), '2027-01-31T13:45:00.000Z');
  });

  it('mensal: a janela é o início do período, e na carência continua a mesma (limitada a 1 janela)', () => {
    const start = at('2026-11-10T08:00:00Z');
    assert.equal(iso(usageWindowStart(at('2026-11-10T08:00:00Z'), start, 1)), iso(start));
    assert.equal(iso(usageWindowStart(at('2026-12-02T00:00:00Z'), start, 1)), iso(start));
    // Sem o limite (função pura), a janela seguinte começaria no mês 2.
    assert.equal(
      iso(usageWindowStart(at('2026-12-11T00:00:00Z'), start)),
      '2026-12-10T08:00:00.000Z',
    );
  });

  it('anual: mês 1, 6 e 12 do período (e nunca além da 12ª janela)', () => {
    const start = at('2026-03-15T10:00:00Z');
    assert.equal(iso(usageWindowStart(at('2026-03-20T00:00:00Z'), start, 12)), iso(start));
    assert.equal(
      iso(usageWindowStart(at('2026-08-20T00:00:00Z'), start, 12)),
      '2026-08-15T10:00:00.000Z',
    );
    assert.equal(
      iso(usageWindowStart(at('2027-02-20T00:00:00Z'), start, 12)),
      '2027-02-15T10:00:00.000Z',
    );
    // Depois do fim do período (carência do anual): fica na 12ª janela.
    assert.equal(
      iso(usageWindowStart(at('2027-03-17T00:00:00Z'), start, 12)),
      '2027-02-15T10:00:00.000Z',
    );
  });

  it('período que começa no dia 31, com mês curto e ano bissexto', () => {
    const start = at('2027-12-31T00:00:00Z');
    // 2028 é bissexto: a janela do mês 2 começa em 29/02.
    assert.equal(
      iso(usageWindowStart(at('2028-02-29T12:00:00Z'), start, 12)),
      '2028-02-29T00:00:00.000Z',
    );
    assert.equal(
      iso(usageWindowStart(at('2028-02-28T12:00:00Z'), start, 12)),
      '2028-01-31T00:00:00.000Z',
    );
    // 1º de março ainda é a janela de fevereiro (a de março começa em 31/03, ancorada em 31/12).
    assert.equal(
      iso(usageWindowStart(at('2028-03-01T00:00:00Z'), start, 12)),
      '2028-02-29T00:00:00.000Z',
    );
    assert.equal(
      iso(usageWindowEnd(at('2028-02-29T00:00:00Z'), start)),
      '2028-03-31T00:00:00.000Z',
    );
  });

  it('antes da âncora devolve a própria âncora', () => {
    const start = at('2026-11-10T08:00:00Z');
    assert.equal(iso(usageWindowStart(at('2026-11-01T00:00:00Z'), start, 1)), iso(start));
  });

  it('windowsInPeriod: 12 só no anual pago; 1 no mensal e no teste', () => {
    assert.equal(windowsInPeriod('ANNUAL', 'ACTIVE'), 12);
    assert.equal(windowsInPeriod('ANNUAL', 'TRIAL'), 1);
    assert.equal(windowsInPeriod('MONTHLY', 'ACTIVE'), 1);
  });
});

describe('cotas e entitlements (spec 031)', () => {
  const settings = { graceDays: GRACE, trialTokens: 300_000 };

  it('o teste usa a cota de tokens própria; o plano pago, a do plano; respostas extras somam às duas', () => {
    assert.deepEqual(quotaLimits(subscription('TRIAL'), 0, settings), {
      tokens: 300_000,
      replies: 800,
    });
    assert.deepEqual(quotaLimits(subscription('ACTIVE'), 0, settings), {
      tokens: 3_000_000,
      replies: 800,
    });
    assert.deepEqual(quotaLimits(subscription('ACTIVE'), 500, settings), {
      tokens: 3_000_000 + 500 * TOKENS_PER_EXTRA_REPLY,
      replies: 1_300,
    });
  });

  it('buildEntitlements expõe acesso, módulos e cotas, sem dinheiro', () => {
    const result = buildEntitlements(
      subscription('ACTIVE'),
      { tokens: 10, sentMessages: 2, extraReplies: 0 },
      at('2026-11-15T00:00:00Z'),
      settings,
    );
    assert.deepEqual(result, {
      access: 'ok',
      agenda: true,
      stock: false,
      tokens: { used: 10, limit: 3_000_000 },
      replies: { used: 2, limit: 800 },
    });
    assert.doesNotMatch(JSON.stringify(result), /cents|price|preço/i);
  });

  it('quotaBlockReason: a que estourar primeiro; acesso bloqueado ganha das cotas', () => {
    const base = { access: 'ok', agenda: true, stock: true } as const;
    assert.equal(
      quotaBlockReason({
        ...base,
        tokens: { used: 9, limit: 10 },
        replies: { used: 9, limit: 10 },
      }),
      null,
    );
    assert.equal(
      quotaBlockReason({
        ...base,
        tokens: { used: 9, limit: 10 },
        replies: { used: 10, limit: 10 },
      }),
      'replies',
    );
    assert.equal(
      quotaBlockReason({
        ...base,
        tokens: { used: 11, limit: 10 },
        replies: { used: 1, limit: 10 },
      }),
      'tokens',
    );
    assert.equal(
      quotaBlockReason({
        access: 'blocked',
        agenda: true,
        stock: true,
        tokens: { used: 99, limit: 10 },
        replies: null,
      }),
      'inactive',
    );
    assert.equal(
      quotaBlockReason({ access: 'grace', agenda: true, stock: true, tokens: null, replies: null }),
      null,
    );
  });

  it('alertas a 80% e 100%, sem alertar com limite inválido', () => {
    assert.deepEqual(reachedAlertFractions(79, 100), []);
    assert.deepEqual(reachedAlertFractions(80, 100), [0.8]);
    assert.deepEqual(reachedAlertFractions(100, 100), [0.8, 1]);
    assert.deepEqual(reachedAlertFractions(5, 0), []);
  });

  it('estimativa da Meta = mensagens x valor do catálogo, em milésimos de centavo', () => {
    assert.equal(metaEstimateMilliCents(100, 3_500), 350_000);
    assert.equal(metaEstimateMilliCents(-1, 3_500), 0);
  });

  it('preço total só do catálogo: base mais os módulos marcados', () => {
    const price = { baseCents: 5_900, agendaCents: 2_900, stockCents: 1_900 };
    assert.equal(priceTotalCents(price, { agenda: false, stock: false }), 5_900);
    assert.equal(priceTotalCents(price, { agenda: true, stock: true }), 10_700);
  });
});

describe('período pago e janelas de uso do checkout (spec 031, E3)', () => {
  const START = at('2026-01-31T12:00:00Z');

  it('windowsInSpan conta os meses do período ancorados no início (dia 31 sem deriva)', () => {
    assert.equal(windowsInSpan(START, addMonthsUtc(START, 1)), 1);
    assert.equal(windowsInSpan(START, addMonthsUtc(START, 2)), 2);
    assert.equal(windowsInSpan(START, addMonthsUtc(START, 12)), 12);
    assert.equal(windowsInSpan(START, addMonthsUtc(START, 24)), 24);
    // Teste gratuito (dias) ainda tem uma janela.
    assert.equal(windowsInSpan(START, new Date(START.getTime() + 7 * DAY)), 1);
  });

  it('subscriptionWindows: 1 no teste; nos pagos, os meses do período', () => {
    const trial = subscription('TRIAL', {
      currentPeriodStart: START,
      currentPeriodEnd: addMonthsUtc(START, 12),
    });
    assert.equal(subscriptionWindows(trial), 1);
    const annual = subscription('ACTIVE', {
      currentPeriodStart: START,
      currentPeriodEnd: addMonthsUtc(START, 12),
    });
    assert.equal(subscriptionWindows(annual), 12);
  });

  it('teste e assinatura expirada recomeçam em now, no ciclo escolhido', () => {
    const now = at('2026-11-10T12:00:00Z');
    for (const status of ['TRIAL', 'EXPIRED'] as const) {
      const period = computePaidPeriod(
        subscription(status, {
          currentPeriodStart: at('2026-11-01T00:00:00Z'),
          currentPeriodEnd: at('2026-11-08T00:00:00Z'),
          trialEndsAt: at('2026-11-08T00:00:00Z'),
        }),
        now,
        GRACE,
        'ANNUAL',
      );
      assert.equal(period.continuing, false);
      assert.equal(iso(period.periodStart), iso(now));
      assert.equal(iso(period.periodEnd), '2027-11-10T12:00:00.000Z');
    }
  });

  it('renovação antecipada e paga na carência continuam do período vigente; passada a carência, recomeça', () => {
    const base = {
      currentPeriodStart: at('2026-11-10T12:00:00Z'),
      currentPeriodEnd: at('2026-12-10T12:00:00Z'),
    };
    const active = subscription('ACTIVE', base);
    const early = computePaidPeriod(active, at('2026-12-01T00:00:00Z'), GRACE, 'MONTHLY');
    assert.equal(early.continuing, true);
    assert.equal(iso(early.periodStart), '2026-11-10T12:00:00.000Z');
    assert.equal(iso(early.periodEnd), '2027-01-10T12:00:00.000Z');
    // No instante exato do vencimento ainda vale a carência.
    const exact = computePaidPeriod(active, at('2026-12-10T12:00:00Z'), GRACE, 'MONTHLY');
    assert.equal(iso(exact.periodEnd), '2027-01-10T12:00:00.000Z');
    // Último instante da carência (5 dias) e o primeiro depois dele.
    const lastGrace = computePaidPeriod(active, at('2026-12-15T11:59:59Z'), GRACE, 'MONTHLY');
    assert.equal(lastGrace.continuing, true);
    const late = computePaidPeriod(active, at('2026-12-15T12:00:00Z'), GRACE, 'MONTHLY');
    assert.equal(late.continuing, false);
    assert.equal(iso(late.periodStart), '2026-12-15T12:00:00.000Z');
    assert.equal(iso(late.periodEnd), '2027-01-15T12:00:00.000Z');
  });

  it('cancelada para o fim do período: ainda vigente continua; vencida recomeça (sem carência)', () => {
    const base = {
      currentPeriodStart: at('2026-11-10T12:00:00Z'),
      currentPeriodEnd: at('2026-12-10T12:00:00Z'),
      cancelAtPeriodEnd: true,
    };
    const during = computePaidPeriod(
      subscription('ACTIVE', base),
      at('2026-12-01T00:00:00Z'),
      GRACE,
      'MONTHLY',
    );
    assert.equal(during.continuing, true);
    const after = computePaidPeriod(
      subscription('ACTIVE', base),
      at('2026-12-11T00:00:00Z'),
      GRACE,
      'MONTHLY',
    );
    assert.equal(after.continuing, false);
  });

  it('renovações antecipadas encadeadas ancoram no início (anual: 12 + 12 = 24 janelas; sem deriva de dia)', () => {
    const first = computePaidPeriod(
      subscription('ACTIVE', {
        currentPeriodStart: START,
        currentPeriodEnd: addMonthsUtc(START, 1),
      }),
      at('2026-02-10T00:00:00Z'),
      GRACE,
      'MONTHLY',
    );
    // 31/jan + 2 meses = 31/mar (e não 28/mar, o que daria a deriva de somar do fim "28/fev").
    assert.equal(iso(first.periodEnd), '2026-03-31T12:00:00.000Z');
    const annual = computePaidPeriod(
      subscription('ACTIVE', {
        cycle: 'ANNUAL',
        currentPeriodStart: START,
        currentPeriodEnd: addMonthsUtc(START, 12),
      }),
      at('2026-12-01T00:00:00Z'),
      GRACE,
      'ANNUAL',
    );
    assert.equal(windowsInSpan(annual.periodStart, annual.periodEnd), 24);
  });
});

describe('troca de plano: classificação e upgrade proporcional (spec 031, D11)', () => {
  const ESS = { planCode: 'ESSENTIAL', cycle: 'MONTHLY', agenda: false, stock: false } as const;

  it('classifyChange: igual, sobe, desce, misto e ciclo', () => {
    assert.equal(classifyChange(ESS, ESS), 'same');
    assert.equal(classifyChange(ESS, { ...ESS, agenda: true }), 'up');
    assert.equal(classifyChange(ESS, { ...ESS, planCode: 'SCALE' }), 'up');
    assert.equal(classifyChange(ESS, { ...ESS, planCode: 'PROFESSIONAL', stock: true }), 'up');
    const pro = { ...ESS, planCode: 'PROFESSIONAL', agenda: true } as const;
    assert.equal(classifyChange(pro, ESS), 'down');
    assert.equal(classifyChange(pro, { ...pro, agenda: false }), 'down');
    assert.equal(classifyChange(pro, { ...pro, planCode: 'ESSENTIAL', stock: true }), 'mixed');
    assert.equal(classifyChange(ESS, { ...ESS, cycle: 'ANNUAL' }), 'cycle');
  });

  const base = (overrides: Partial<Parameters<typeof prorateUpgradeCents>[0]> = {}) => ({
    currentTotalCents: 5_900,
    newTotalCents: 14_900,
    cycle: 'MONTHLY' as const,
    periodStart: at('2026-11-10T12:00:00Z'),
    periodEnd: at('2026-12-10T12:00:00Z'),
    now: at('2026-11-20T12:00:00Z'),
    ...overrides,
  });

  it('mensal: fração restante exata (20 dos 30 dias) e primeiro dia cobra a diferença cheia', () => {
    const mid = prorateUpgradeCents(base());
    assert.ok(mid.ok);
    assert.equal(mid.cents, 6_000);
    const first = prorateUpgradeCents(base({ now: at('2026-11-10T12:00:00Z') }));
    assert.ok(first.ok);
    assert.equal(first.cents, 9_000);
    // Último dia inteiro: 1 de 30 dias.
    const last = prorateUpgradeCents(base({ now: at('2026-12-09T12:00:00Z') }));
    assert.ok(last.ok);
    assert.equal(last.cents, 300);
  });

  it('arredonda PARA CIMA em centavos inteiros', () => {
    // Período de 3 dias, restam 1: 1001 / 3 = 333,67 -> 334.
    const result = prorateUpgradeCents({
      currentTotalCents: 0 + 1_000,
      newTotalCents: 2_001,
      cycle: 'MONTHLY',
      periodStart: at('2026-11-01T00:00:00Z'),
      periodEnd: at('2026-11-04T00:00:00Z'),
      now: at('2026-11-03T00:00:00Z'),
    });
    assert.ok(result.ok);
    assert.equal(result.cents, 334);
  });

  it('piso de R$ 1,00 (mínimo do link)', () => {
    const result = prorateUpgradeCents(base({ currentTotalCents: 5_900, newTotalCents: 5_950 }));
    assert.ok(result.ok);
    assert.equal(result.cents, 100);
  });

  it('menos de 1 dia restante é recusado (renove); fora do período e sem aumento também', () => {
    const late = prorateUpgradeCents(base({ now: at('2026-12-09T12:00:01Z') }));
    assert.deepEqual(late, { ok: false, reason: 'too_late' });
    assert.deepEqual(prorateUpgradeCents(base({ now: at('2026-12-10T12:00:00Z') })), {
      ok: false,
      reason: 'not_in_period',
    });
    assert.deepEqual(prorateUpgradeCents(base({ now: at('2026-11-01T00:00:00Z') })), {
      ok: false,
      reason: 'not_in_period',
    });
    assert.deepEqual(prorateUpgradeCents(base({ newTotalCents: 5_900 })), {
      ok: false,
      reason: 'no_increase',
    });
    assert.deepEqual(prorateUpgradeCents(base({ newTotalCents: 100 })), {
      ok: false,
      reason: 'no_increase',
    });
  });

  it('anual com ano bissexto: a fração é sobre os milissegundos reais do período (366 dias)', () => {
    const start = at('2028-02-15T00:00:00Z');
    const end = addMonthsUtc(start, 12); // 2029-02-15: 366 dias
    const now = at('2028-08-16T00:00:00Z'); // 183 dias depois: restam 183 de 366 = metade
    const result = prorateUpgradeCents({
      currentTotalCents: 56_640,
      newTotalCents: 156_640,
      cycle: 'ANNUAL',
      periodStart: start,
      periodEnd: end,
      now,
    });
    assert.ok(result.ok);
    assert.equal(result.totalMs, 366 * DAY);
    assert.equal(result.cents, 50_000);
  });

  it('período que começa no dia 31 (mês curto) e período estendido por renovação antecipada', () => {
    const start = at('2026-01-31T12:00:00Z');
    // Fev/2026 tem 28 dias: período de 28 dias, restam 14.
    const short = prorateUpgradeCents({
      currentTotalCents: 1_000,
      newTotalCents: 1_280,
      cycle: 'MONTHLY',
      periodStart: start,
      periodEnd: addMonthsUtc(start, 1),
      now: at('2026-02-14T12:00:00Z'),
    });
    assert.ok(short.ok);
    assert.equal(short.cents, 140);
    // Dois ciclos pagos (2 meses): a diferença de cada ciclo conta, sobre o período inteiro.
    const start2 = at('2026-11-10T12:00:00Z');
    const two = prorateUpgradeCents({
      currentTotalCents: 5_900,
      newTotalCents: 14_900,
      cycle: 'MONTHLY',
      periodStart: start2,
      periodEnd: addMonthsUtc(start2, 2),
      now: start2,
    });
    assert.ok(two.ok);
    assert.equal(two.cents, 18_000);
  });
});
