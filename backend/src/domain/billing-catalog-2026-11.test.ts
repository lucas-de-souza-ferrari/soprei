import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type BillingCycle,
  type CatalogLike,
  classifyChange,
  effectiveQuotas,
  type PendingChange,
  perReplyMilliCents,
  PLAN_CODES,
  type PlanCode,
  type PlanSelection,
  priceTotalCents,
  prorateUpgradeCents,
  renewalPriceChange,
  renewalPriceIncrease,
  type SubscriptionRecord,
} from './billing.js';
import { dueNotices, NOTICE_PRICE_CHANGE_DAYS, type NoticeSubject } from './billing-notices.js';

// Spec 040, E1: catálogo novo (D1, D2), regra do máximo (D4), preço por resposta (D9), aviso de reajuste (D6)
// e o upgrade proporcional entre o preço antigo (o que a assinatura pagou) e o catálogo novo.

const DAY = 86_400_000;

interface Row {
  readonly base: number;
  readonly agenda: number;
  readonly stock: number;
}
type Prices = Readonly<Record<PlanCode, Readonly<Record<BillingCycle, Row>>>>;

/** Catálogo da 031 (versão 1, semente de 2026-11-09). */
const OLD: Prices = {
  ESSENTIAL: {
    MONTHLY: { base: 5_900, agenda: 2_900, stock: 1_900 },
    ANNUAL: { base: 56_640, agenda: 27_840, stock: 18_240 },
  },
  PROFESSIONAL: {
    MONTHLY: { base: 14_900, agenda: 4_900, stock: 3_900 },
    ANNUAL: { base: 143_040, agenda: 47_040, stock: 37_440 },
  },
  SCALE: {
    MONTHLY: { base: 34_900, agenda: 9_900, stock: 7_900 },
    ANNUAL: { base: 335_040, agenda: 95_040, stock: 75_840 },
  },
};

/** Catálogo novo (spec 040, D1): anual = 10 x o mensal, para o plano e para os módulos. */
const NEW: Prices = {
  ESSENTIAL: {
    MONTHLY: { base: 4_790, agenda: 2_900, stock: 1_900 },
    ANNUAL: { base: 47_900, agenda: 29_000, stock: 19_000 },
  },
  PROFESSIONAL: {
    MONTHLY: { base: 11_990, agenda: 4_900, stock: 3_900 },
    ANNUAL: { base: 119_900, agenda: 49_000, stock: 39_000 },
  },
  SCALE: {
    MONTHLY: { base: 34_900, agenda: 9_900, stock: 7_900 },
    ANNUAL: { base: 349_000, agenda: 99_000, stock: 79_000 },
  },
};
const NEW_REPLIES: Readonly<Record<PlanCode, number>> = {
  ESSENTIAL: 2_500,
  PROFESSIONAL: 8_000,
  SCALE: 30_000,
};
const OLD_QUOTAS: Readonly<Record<PlanCode, { monthlyReplies: number; monthlyTokens: number }>> = {
  ESSENTIAL: { monthlyReplies: 800, monthlyTokens: 3_000_000 },
  PROFESSIONAL: { monthlyReplies: 3_200, monthlyTokens: 12_000_000 },
  SCALE: { monthlyReplies: 10_800, monthlyTokens: 40_000_000 },
};

function catalogOf(prices: Prices): CatalogLike[] {
  return PLAN_CODES.map((code) => ({
    plan: { code },
    prices: (['MONTHLY', 'ANNUAL'] as const).map((cycle) => ({
      cycle,
      baseCents: prices[code][cycle].base,
      agendaCents: prices[code][cycle].agenda,
      stockCents: prices[code][cycle].stock,
    })),
  }));
}

function oldSubscription(
  code: PlanCode,
  cycle: BillingCycle,
  modules: { agenda: boolean; stock: boolean },
  pendingChange: PendingChange | null = null,
): SubscriptionRecord {
  const row = OLD[code][cycle];
  return {
    id: 's',
    accountId: 'a',
    plan: {
      id: 'p',
      code,
      name: code,
      maxCompanies: 10,
      ...OLD_QUOTAS[code],
      metaEstimateMilliCents: 3_500,
      version: 1,
    },
    price: {
      id: 'pr',
      cycle,
      baseCents: row.base,
      agendaCents: row.agenda,
      stockCents: row.stock,
      whatsappBillingMode: 'CUSTOMER_PAYS_META',
      metaPerReplyMilliCents: 3_500,
      extraPackCents: 5_900,
      extraPackReplies: 500,
      version: 1,
      validFrom: new Date('2026-11-01T00:00:00Z'),
    },
    cycle,
    agendaEnabled: modules.agenda,
    stockEnabled: modules.stock,
    status: 'ACTIVE',
    currentPeriodStart: new Date('2026-11-10T12:00:00Z'),
    currentPeriodEnd: new Date(
      cycle === 'ANNUAL' ? '2027-11-10T12:00:00Z' : '2026-12-10T12:00:00Z',
    ),
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    pendingChange,
  };
}

const MODULES = [
  { agenda: false, stock: false },
  { agenda: true, stock: false },
  { agenda: false, stock: true },
  { agenda: true, stock: true },
] as const;

describe('catálogo novo: regras (spec 040, D1, D2 e D9)', () => {
  it('anual = 10 x mensal para o plano e para os módulos; tokens = 6.000 x respostas', () => {
    for (const code of PLAN_CODES) {
      const monthly = NEW[code].MONTHLY;
      const annual = NEW[code].ANNUAL;
      assert.equal(annual.base, monthly.base * 10, code);
      assert.equal(annual.agenda, monthly.agenda * 10, code);
      assert.equal(annual.stock, monthly.stock * 10, code);
    }
    assert.deepEqual(
      PLAN_CODES.map((code) => NEW_REPLIES[code] * 6_000),
      [15_000_000, 48_000_000, 180_000_000],
    );
  });

  it('perReplyMilliCents: valores da spec, arredondados para baixo, e estritamente decrescente por degrau', () => {
    const monthly = PLAN_CODES.map((code) =>
      perReplyMilliCents(NEW[code].MONTHLY.base, NEW_REPLIES[code], 'MONTHLY'),
    );
    const annual = PLAN_CODES.map((code) =>
      perReplyMilliCents(NEW[code].ANNUAL.base, NEW_REPLIES[code], 'ANNUAL'),
    );
    assert.deepEqual(monthly, [1_916, 1_498, 1_163]);
    assert.deepEqual(annual, [1_596, 1_248, 969]);
    for (const series of [monthly, annual]) {
      for (let i = 1; i < series.length; i += 1) {
        assert.ok(
          (series[i] ?? 0) < (series[i - 1] ?? 0),
          'o preço por resposta cai a cada degrau',
        );
      }
    }
  });

  it('perReplyMilliCents com cota ou preço inválido devolve 0', () => {
    assert.equal(perReplyMilliCents(4_790, 0, 'MONTHLY'), 0);
    assert.equal(perReplyMilliCents(0, 2_500, 'MONTHLY'), 0);
  });
});

describe('effectiveQuotas: regra do máximo (spec 040, D4)', () => {
  it('devolve o maior por campo', () => {
    assert.deepEqual(
      effectiveQuotas(
        { monthlyReplies: 800, monthlyTokens: 3_000_000 },
        { monthlyReplies: 2_500, monthlyTokens: 15_000_000 },
      ),
      { monthlyReplies: 2_500, monthlyTokens: 15_000_000 },
    );
    // Campo a campo, não a linha inteira.
    assert.deepEqual(
      effectiveQuotas(
        { monthlyReplies: 3_000, monthlyTokens: 1_000 },
        { monthlyReplies: 2_500, monthlyTokens: 15_000_000 },
      ),
      { monthlyReplies: 3_000, monthlyTokens: 15_000_000 },
    );
  });

  it('versão vigente menor que a da assinatura: mantém a da assinatura (redução futura não atinge quem já pagou)', () => {
    const own = { monthlyReplies: 2_500, monthlyTokens: 15_000_000 };
    assert.deepEqual(
      effectiveQuotas(own, { monthlyReplies: 2_000, monthlyTokens: 9_000_000 }),
      own,
    );
  });

  it('a mesma linha (ou catálogo sem o código) não muda nada', () => {
    const own = { monthlyReplies: 2_500, monthlyTokens: 15_000_000 };
    assert.deepEqual(effectiveQuotas(own, own), own);
    assert.deepEqual(effectiveQuotas(own, undefined), own);
    assert.deepEqual(effectiveQuotas(own, null), own);
  });
});

describe('upgrade proporcional do preço antigo para o catálogo novo (spec 040, E1)', () => {
  it('toda combinação "up" (planos, módulos e os dois ciclos) dá valor positivo e nunca cai em no_increase', () => {
    let checked = 0;
    for (const cycle of ['MONTHLY', 'ANNUAL'] as const) {
      for (const fromCode of PLAN_CODES) {
        for (const fromModules of MODULES) {
          const sub = oldSubscription(fromCode, cycle, fromModules);
          const current: PlanSelection = { planCode: fromCode, cycle, ...fromModules };
          for (const toCode of PLAN_CODES) {
            for (const toModules of MODULES) {
              const target: PlanSelection = { planCode: toCode, cycle, ...toModules };
              if (classifyChange(current, target) !== 'up') continue;
              const row = NEW[toCode][cycle];
              const result = prorateUpgradeCents({
                currentTotalCents: priceTotalCents(sub.price, fromModules),
                newTotalCents: priceTotalCents(
                  { baseCents: row.base, agendaCents: row.agenda, stockCents: row.stock },
                  toModules,
                ),
                cycle,
                periodStart: sub.currentPeriodStart,
                periodEnd: sub.currentPeriodEnd,
                now: new Date(sub.currentPeriodStart.getTime() + 10 * DAY),
              });
              const label = `${cycle} ${fromCode}${JSON.stringify(fromModules)} -> ${toCode}${JSON.stringify(toModules)}`;
              assert.ok(result.ok, label);
              assert.ok(result.cents > 0, label);
              checked += 1;
            }
          }
        }
      }
    }
    // Garantia de que o laço cobriu algo (não passou vazio).
    assert.ok(checked > 40, `combinações verificadas: ${String(checked)}`);
  });
});

describe('renewalPriceIncrease: aviso de reajuste (spec 040, D6)', () => {
  const catalog = catalogOf(NEW);
  const none = { agenda: false, stock: false };

  it('anual do Escala antigo -> verdadeiro (3.350,40 -> 3.490,00)', () => {
    const sub = oldSubscription('SCALE', 'ANNUAL', none);
    assert.equal(renewalPriceIncrease(sub, catalog), true);
    assert.deepEqual(renewalPriceChange(sub, catalog), {
      currentCents: 335_040,
      nextCents: 349_000,
    });
  });

  it('anual do Essencial antigo -> falso (566,40 -> 479,00)', () => {
    assert.equal(
      renewalPriceIncrease(oldSubscription('ESSENTIAL', 'ANNUAL', none), catalog),
      false,
    );
  });

  it('anual antigo com módulos sobe (os módulos anuais sobem 4,2%)', () => {
    assert.equal(
      renewalPriceIncrease(
        oldSubscription('SCALE', 'ANNUAL', { agenda: true, stock: true }),
        catalog,
      ),
      true,
    );
  });

  it('mensal de todos os planos antigos, sem e com módulos -> falso', () => {
    for (const code of PLAN_CODES) {
      for (const modules of MODULES) {
        assert.equal(
          renewalPriceIncrease(oldSubscription(code, 'MONTHLY', modules), catalog),
          false,
          `${code} ${JSON.stringify(modules)}`,
        );
      }
    }
  });

  it('troca agendada para um plano mais caro -> verdadeiro (vale a seleção que vai renovar)', () => {
    const sub = oldSubscription('ESSENTIAL', 'MONTHLY', none, {
      planCode: 'PROFESSIONAL',
      cycle: 'MONTHLY',
      agenda: false,
      stock: false,
    });
    assert.equal(renewalPriceIncrease(sub, catalog), true);
  });

  it('plano ou ciclo fora do catálogo: sem comparação (falso)', () => {
    const sub = oldSubscription('SCALE', 'ANNUAL', none);
    assert.equal(renewalPriceIncrease(sub, []), false);
    assert.equal(renewalPriceChange(sub, []), null);
  });
});

describe('dueNotices: PRICE_CHANGE entre 30 e 45 dias antes da renovação (spec 040, D6)', () => {
  const SETTINGS = { graceDays: 5, trialTokens: 600_000, trialReplies: 100 } as const;
  const catalog = catalogOf(NEW);

  function subjectFor(sub: SubscriptionRecord, withCatalog = true): NoticeSubject {
    return {
      subscription: sub,
      usage: { tokens: 0, sentMessages: 0, extraReplies: 0 },
      usageWindowStart: sub.currentPeriodStart,
      companies: 1,
      pendingPlanMaxCompanies: null,
      ...(withCatalog ? { catalog } : {}),
    };
  }
  const kindsAt = (subject: NoticeSubject, daysBefore: number) =>
    dueNotices(
      subject,
      new Date(subject.subscription.currentPeriodEnd.getTime() - daysBefore * DAY),
      SETTINGS,
    ).map((notice) => notice.kind);

  const scale = oldSubscription('SCALE', 'ANNUAL', { agenda: false, stock: false });

  it('sai a 30 e a 45 dias (limites incluídos) e entre eles; não sai a 46 nem a 29', () => {
    assert.equal(NOTICE_PRICE_CHANGE_DAYS.min, 30);
    assert.equal(NOTICE_PRICE_CHANGE_DAYS.max, 45);
    for (const days of [30, 31, 40, 45]) {
      assert.deepEqual(kindsAt(subjectFor(scale), days), ['PRICE_CHANGE'], `${String(days)} dias`);
    }
    assert.deepEqual(kindsAt(subjectFor(scale), 46), []);
    assert.deepEqual(kindsAt(subjectFor(scale), 29), []);
  });

  it('a chave do aviso é o fim do período (uma vez por período)', () => {
    const [notice] = dueNotices(
      subjectFor(scale),
      new Date(scale.currentPeriodEnd.getTime() - 40 * DAY),
      SETTINGS,
    );
    assert.equal(notice?.kind, 'PRICE_CHANGE');
    assert.equal(notice.windowStart.getTime(), scale.currentPeriodEnd.getTime());
  });

  it('não sai com cancelAtPeriodEnd, para quem não sobe, sem catálogo, no teste ou vencida', () => {
    assert.deepEqual(kindsAt(subjectFor({ ...scale, cancelAtPeriodEnd: true }), 40), []);
    assert.deepEqual(
      kindsAt(
        subjectFor(oldSubscription('ESSENTIAL', 'ANNUAL', { agenda: false, stock: false })),
        40,
      ),
      [],
    );
    assert.deepEqual(kindsAt(subjectFor(scale, false), 40), []);
    assert.deepEqual(
      kindsAt(subjectFor({ ...scale, status: 'TRIAL', trialEndsAt: scale.currentPeriodEnd }), 40),
      [],
    );
    assert.deepEqual(kindsAt(subjectFor({ ...scale, status: 'EXPIRED' }), 40), []);
  });
});
