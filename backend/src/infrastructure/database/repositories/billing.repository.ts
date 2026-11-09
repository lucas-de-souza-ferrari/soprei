import type { Prisma } from '../../../generated/prisma/client.js';
import {
  AccountId,
  type BillingRepository,
  type CatalogEntry,
  type OrderSummary,
  type PlanPriceRecord,
  type PlanRecord,
  type SubscriptionRecord,
  type TrialSettings,
  type UsageWindow,
  usageWindowStart,
  windowsInPeriod,
} from '../../../domain/index.js';
import { DatabaseError } from '../../../shared/errors/index.js';
import { isUuid } from '../../../shared/utils/index.js';
import type { TenantScopedDb, TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { withRepositoryErrors } from './repository-errors.js';

const DAY_MS = 86_400_000;

const subscriptionInclude = { plan: true, price: true } as const;
type SubscriptionRow = Prisma.SubscriptionGetPayload<{ include: typeof subscriptionInclude }>;

export function toPlan(row: Prisma.PlanGetPayload<object>): PlanRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    maxCompanies: row.maxCompanies,
    monthlyTokens: Number(row.monthlyTokens),
    monthlyReplies: row.monthlyReplies,
    metaEstimateMilliCents: row.metaEstimateMilliCents,
    version: row.version,
  };
}

export function toPrice(row: Prisma.PlanPriceGetPayload<object>): PlanPriceRecord {
  return {
    id: row.id,
    cycle: row.cycle,
    baseCents: row.baseCents,
    agendaCents: row.agendaCents,
    stockCents: row.stockCents,
    whatsappBillingMode: row.whatsappBillingMode,
    metaPerReplyMilliCents: row.metaPerReplyMilliCents,
    extraPackCents: row.extraPackCents,
    extraPackReplies: row.extraPackReplies,
    version: row.version,
    validFrom: row.validFrom,
  };
}

export function toSubscription(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    plan: toPlan(row.plan),
    price: toPrice(row.price),
    cycle: row.cycle,
    agendaEnabled: row.agendaEnabled,
    stockEnabled: row.stockEnabled,
    status: row.status,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    trialEndsAt: row.trialEndsAt,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  };
}

/** A assinatura de uma conta (ou `null`). Só por `accountId` ou pelo id da própria assinatura. */
export async function findSubscriptionByAccount(
  db: TenantScopedDb,
  accountId: string,
): Promise<SubscriptionRecord | null> {
  const row = await db.subscription.findFirst({
    where: { accountId },
    include: subscriptionInclude,
  });
  return row === null ? null : toSubscription(row);
}

export async function findSubscriptionById(
  db: TenantScopedDb,
  subscriptionId: string,
): Promise<SubscriptionRecord | null> {
  const row = await db.subscription.findFirst({
    where: { id: subscriptionId },
    include: subscriptionInclude,
  });
  return row === null ? null : toSubscription(row);
}

/**
 * A assinatura da conta; se não existe, cria o **teste gratuito** (D7): plano Essencial, preço mensal
 * vigente do modo "a empresa paga a Meta", com Agenda e Estoque liberados, e `trialDays` de prazo. Uma
 * vez por conta (`account_id` é único; a corrida cai em `skipDuplicates`). Conta que já teve teste
 * (mesmo expirado) nunca ganha outro: a linha existente é devolvida.
 */
export async function ensureTrialSubscription(
  db: TenantScopedDb,
  accountId: string,
  now: Date,
  settings: TrialSettings,
): Promise<SubscriptionRecord> {
  const existing = await findSubscriptionByAccount(db, accountId);
  if (existing !== null) return existing;
  const plan = await db.plan.findFirst({
    where: { code: 'ESSENTIAL', active: true },
    orderBy: { version: 'desc' },
  });
  const price =
    plan === null
      ? null
      : await db.planPrice.findFirst({
          where: {
            planId: plan.id,
            cycle: 'MONTHLY',
            whatsappBillingMode: 'CUSTOMER_PAYS_META',
            validFrom: { lte: now },
          },
          orderBy: { version: 'desc' },
        });
  if (plan === null || price === null) {
    throw new DatabaseError('Catálogo de planos ausente', {
      context: { reason: 'trial_plan_missing' },
    });
  }
  const trialEnd = new Date(now.getTime() + Math.max(1, settings.trialDays) * DAY_MS);
  await db.subscription.createMany({
    data: [
      {
        accountId,
        planId: plan.id,
        priceId: price.id,
        cycle: 'MONTHLY',
        agendaEnabled: true,
        stockEnabled: true,
        status: 'TRIAL',
        currentPeriodStart: now,
        currentPeriodEnd: trialEnd,
        trialEndsAt: trialEnd,
      },
    ],
    skipDuplicates: true,
  });
  const created = await findSubscriptionByAccount(db, accountId);
  if (created === null) {
    throw new DatabaseError('Assinatura de teste não encontrada depois de criada', {
      context: { reason: 'trial_missing_after_create' },
    });
  }
  return created;
}

/** Início da janela de uso atual de uma assinatura (a mesma regra para quem mede e para quem lê). */
export function currentWindowStart(
  subscription: Pick<SubscriptionRecord, 'currentPeriodStart' | 'cycle' | 'status'>,
  now: Date,
): Date {
  return usageWindowStart(
    now,
    subscription.currentPeriodStart,
    windowsInPeriod(subscription.cycle, subscription.status),
  );
}

/**
 * Cobrança da CONTA (spec 031). `Subscription`, `PaymentOrder`, `UsageCounter` e os demais são models
 * **globais**: a barreira é que todo método parte do `AccountId` (a assinatura é achada por
 * `accountId`; pedidos e uso só pelo id dessa assinatura) e que nenhuma rota recebe o id da conta do
 * navegador. Só `findFirst`, `findMany`, `count` e `createMany`; nenhum SQL cru.
 */
export class PrismaBillingRepository implements BillingRepository {
  constructor(private readonly db: TenantScopedPrisma) {}

  findSubscription(accountId: string): Promise<SubscriptionRecord | null> {
    return withRepositoryErrors('Billing.findSubscription', () =>
      findSubscriptionByAccount(this.db, AccountId.parse(accountId)),
    );
  }

  ensureTrial(accountId: string, now: Date, settings: TrialSettings): Promise<SubscriptionRecord> {
    return withRepositoryErrors('Billing.ensureTrial', () =>
      ensureTrialSubscription(this.db, AccountId.parse(accountId), now, settings),
    );
  }

  catalog(now: Date, allowSopreiPaysMeta: boolean): Promise<readonly CatalogEntry[]> {
    return withRepositoryErrors('Billing.catalog', async () => {
      const plans = await this.db.plan.findMany({
        where: { active: true },
        orderBy: [{ code: 'asc' }, { version: 'desc' }],
        include: {
          prices: {
            where: {
              validFrom: { lte: now },
              // Gate do modo S: sem a flag, versão de preço SOPREI_PAYS_META é ignorada na leitura.
              ...(allowSopreiPaysMeta
                ? {}
                : { whatsappBillingMode: 'CUSTOMER_PAYS_META' as const }),
            },
            orderBy: [{ version: 'desc' }],
          },
        },
      });
      // Um plano por código (a versão mais nova ativa) e, por ciclo, o preço mais novo vigente.
      const seen = new Set<string>();
      const entries: CatalogEntry[] = [];
      for (const row of plans) {
        if (seen.has(row.code)) continue;
        seen.add(row.code);
        const byCycle = new Map<string, PlanPriceRecord>();
        for (const price of row.prices) {
          if (!byCycle.has(price.cycle)) byCycle.set(price.cycle, toPrice(price));
        }
        entries.push({ plan: toPlan(row), prices: [...byCycle.values()] });
      }
      return entries;
    });
  }

  usage(accountId: string, windowStart: Date): Promise<UsageWindow> {
    return withRepositoryErrors('Billing.usage', async () => {
      const row = await this.db.usageCounter.findFirst({
        where: { windowStart, subscription: { accountId: AccountId.parse(accountId) } },
      });
      return {
        windowStart,
        tokens: Number(row?.tokens ?? 0n),
        sentMessages: Number(row?.sentMessages ?? 0n),
        extraReplies: row?.extraReplies ?? 0,
      };
    });
  }

  listOrders(accountId: string, limit: number): Promise<readonly OrderSummary[]> {
    return withRepositoryErrors('Billing.listOrders', async () => {
      const rows = await this.db.paymentOrder.findMany({
        where: { subscription: { accountId: AccountId.parse(accountId) } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: Math.min(Math.max(1, limit), 50),
      });
      return rows.map(toOrderSummary);
    });
  }

  findOrder(accountId: string, orderId: string): Promise<OrderSummary | null> {
    return withRepositoryErrors('Billing.findOrder', async () => {
      // Id malformado é o mesmo "não existe" (e o driver nem recebe valor que não é UUID).
      if (!isUuid(orderId)) return null;
      const row = await this.db.paymentOrder.findFirst({
        where: { id: orderId, subscription: { accountId: AccountId.parse(accountId) } },
      });
      return row === null ? null : toOrderSummary(row);
    });
  }

  countCompanies(accountId: string): Promise<number> {
    return withRepositoryErrors('Billing.countCompanies', () =>
      this.db.company.count({
        where: { deletedAt: null, subscription: { accountId: AccountId.parse(accountId) } },
      }),
    );
  }
}

function toOrderSummary(row: Prisma.PaymentOrderGetPayload<object>): OrderSummary {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    amountCents: row.amountCents,
    createdAt: row.createdAt,
    paidAt: row.paidAt,
  };
}
