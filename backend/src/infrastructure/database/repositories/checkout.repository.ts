import { z } from 'zod';
import type { Prisma } from '../../../generated/prisma/client.js';
import {
  AccountId,
  BILLING_CYCLES,
  type CheckoutRepository,
  computePaidPeriod,
  type GrantResult,
  type NewOrderInput,
  type OrderBreakdown,
  type PaidFacts,
  type PaymentOrderKindValue,
  type PaymentOrderRecord,
  PLAN_CODES,
  RECONCILE_WINDOW_MS,
  subscriptionWindows,
  usageWindowStart,
  WHATSAPP_BILLING_MODES,
} from '../../../domain/index.js';
import { DatabaseError } from '../../../shared/errors/index.js';
import { isUuid } from '../../../shared/utils/index.js';
import type { TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { runInTransaction } from '../transaction.js';
import { findSubscriptionById } from './billing.repository.js';
import { withRepositoryErrors } from './repository-errors.js';

const breakdownSchema = z.object({
  planCode: z.enum(PLAN_CODES),
  cycle: z.enum(BILLING_CYCLES),
  agenda: z.boolean(),
  stock: z.boolean(),
  priceId: z.uuid(),
  priceVersion: z.number().int(),
  whatsappBillingMode: z.enum(WHATSAPP_BILLING_MODES),
});

/** Pedido ainda não concedido: pode receber o pagamento (EXPIRED incluído: o dinheiro não se perde). */
const GRANTABLE = ['PENDING', 'EXPIRED'] as const;

function toOrder(row: Prisma.PaymentOrderGetPayload<object>): PaymentOrderRecord {
  const breakdown = breakdownSchema.safeParse(row.breakdown);
  if (!breakdown.success) {
    throw new DatabaseError('Pedido com detalhamento inválido', {
      context: { reason: 'order_breakdown_invalid' },
    });
  }
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    kind: row.kind,
    status: row.status,
    amountCents: row.amountCents,
    breakdown: breakdown.data,
    checkoutUrl: row.checkoutUrl,
    providerTransactionRef: row.providerTransactionRef,
    providerSlug: row.providerSlug,
    paidAt: row.paidAt,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/**
 * Pedidos de pagamento da conta (spec 031, E3). Models globais: a barreira é que os métodos de conta
 * partem do AccountId (a assinatura é achada por accountId; pedido de outra conta é "não existe") e que
 * os métodos por orderId, de sistema, só concedem à assinatura do PRÓPRIO pedido. Só findFirst,
 * findMany, count, create, createMany, updateMany e deleteMany; SQL cru apenas no bloqueio da linha da
 * assinatura e na reivindicação da reconciliação (sem dado de pessoa, só ids).
 */
export class PrismaCheckoutRepository implements CheckoutRepository {
  constructor(private readonly db: TenantScopedPrisma) {}

  createPendingOrder(accountId: string, input: NewOrderInput): Promise<PaymentOrderRecord | null> {
    return withRepositoryErrors('Checkout.createPendingOrder', async () => {
      const subscription = await this.db.subscription.findFirst({
        where: { accountId: AccountId.parse(accountId) },
        select: { id: true },
      });
      if (subscription === null) return null;
      const row = await this.db.paymentOrder.create({
        data: {
          id: input.id,
          subscriptionId: subscription.id,
          kind: input.kind,
          amountCents: input.amountCents,
          breakdown: input.breakdown as unknown as Prisma.InputJsonValue,
          expiresAt: input.expiresAt,
        },
      });
      return toOrder(row);
    });
  }

  findOrder(accountId: string, orderId: string): Promise<PaymentOrderRecord | null> {
    return withRepositoryErrors('Checkout.findOrder', async () => {
      if (!isUuid(orderId)) return null;
      const row = await this.db.paymentOrder.findFirst({
        where: { id: orderId, subscription: { accountId: AccountId.parse(accountId) } },
      });
      return row === null ? null : toOrder(row);
    });
  }

  countOrdersSince(accountId: string, since: Date): Promise<number> {
    return withRepositoryErrors('Checkout.countOrdersSince', () =>
      this.db.paymentOrder.count({
        where: {
          createdAt: { gte: since },
          subscription: { accountId: AccountId.parse(accountId) },
        },
      }),
    );
  }

  attachCheckoutUrl(orderId: string, checkoutUrl: string): Promise<void> {
    return withRepositoryErrors('Checkout.attachCheckoutUrl', async () => {
      await this.db.paymentOrder.updateMany({
        where: { id: orderId, status: 'PENDING', checkoutUrl: null },
        data: { checkoutUrl },
      });
    });
  }

  discardUnlinkedOrder(orderId: string): Promise<void> {
    return withRepositoryErrors('Checkout.discardUnlinkedOrder', async () => {
      await this.db.paymentOrder.deleteMany({
        where: { id: orderId, status: 'PENDING', checkoutUrl: null },
      });
    });
  }

  expireSiblings(
    subscriptionId: string,
    kind: PaymentOrderKindValue,
    exceptId: string,
  ): Promise<void> {
    return withRepositoryErrors('Checkout.expireSiblings', async () => {
      await this.db.paymentOrder.updateMany({
        where: { subscriptionId, kind, status: 'PENDING', id: { not: exceptId } },
        data: { status: 'EXPIRED' },
      });
    });
  }

  findOrderById(orderId: string): Promise<PaymentOrderRecord | null> {
    return withRepositoryErrors('Checkout.findOrderById', async () => {
      if (!isUuid(orderId)) return null;
      const row = await this.db.paymentOrder.findFirst({ where: { id: orderId } });
      return row === null ? null : toOrder(row);
    });
  }

  recordWebhookEvent(
    orderId: string,
    event: { readonly transactionNsu: string; readonly slug: string | null },
  ): Promise<boolean> {
    return withRepositoryErrors('Checkout.recordWebhookEvent', async () => {
      if (!isUuid(orderId)) return false;
      // Última referência informada vence: um evento falso não bloqueia o verdadeiro (a confirmação
      // sempre usa os valores do próprio evento ou a consulta; nada aqui concede).
      const { count } = await this.db.paymentOrder.updateMany({
        where: { id: orderId, status: { in: [...GRANTABLE] } },
        data: {
          providerTransactionRef: event.transactionNsu,
          ...(event.slug === null ? {} : { providerSlug: event.slug }),
        },
      });
      return count > 0;
    });
  }

  grantPaidOrder(
    orderId: string,
    facts: PaidFacts,
    now: Date,
    graceDays: number,
  ): Promise<GrantResult> {
    return withRepositoryErrors('Checkout.grantPaidOrder', async () => {
      if (!isUuid(orderId)) return { granted: false };
      return runInTransaction(
        this.db,
        async (tx): Promise<GrantResult> => {
          // Idempotência: só quem muda a linha de PENDING/EXPIRED para PAID concede; as demais
          // confirmações (webhook repetido, "Já paguei", reconciliação) atualizam 0 linhas.
          const claimed = await tx.paymentOrder.updateMany({
            where: { id: orderId, status: { in: [...GRANTABLE] } },
            data: {
              status: 'PAID',
              paidAt: now,
              ...(facts.transactionNsu === null
                ? {}
                : { providerTransactionRef: facts.transactionNsu }),
              ...(facts.slug === null ? {} : { providerSlug: facts.slug }),
              ...(facts.captureMethod === null ? {} : { captureMethod: facts.captureMethod }),
            },
          });
          if (claimed.count === 0) return { granted: false };
          const order = await tx.paymentOrder.findFirst({ where: { id: orderId } });
          if (order === null) return { granted: false };
          const breakdown: OrderBreakdown = toOrder(order).breakdown;

          // Trava a linha da assinatura: dois pedidos da mesma assinatura concedendo juntos se serializam.
          await tx.$queryRaw`
            SELECT id FROM subscriptions WHERE id = ${order.subscriptionId}::uuid FOR NO KEY UPDATE`;
          const subscription = await findSubscriptionById(tx, order.subscriptionId);
          const price = await tx.planPrice.findFirst({ where: { id: breakdown.priceId } });
          if (subscription === null || price === null) {
            // Desfaz tudo (o pedido volta a PENDING): nunca se marca pago sem conceder.
            throw new DatabaseError('Assinatura ou preço do pedido não encontrados', {
              context: { reason: 'grant_target_missing' },
            });
          }
          const period = computePaidPeriod(subscription, now, graceDays, breakdown.cycle);
          await tx.subscription.updateMany({
            where: { id: subscription.id },
            data: {
              planId: price.planId,
              priceId: price.id,
              cycle: breakdown.cycle,
              agendaEnabled: breakdown.agenda,
              stockEnabled: breakdown.stock,
              status: 'ACTIVE',
              currentPeriodStart: period.periodStart,
              currentPeriodEnd: period.periodEnd,
              trialEndsAt: null,
              cancelAtPeriodEnd: false,
            },
          });
          await tx.paymentOrder.updateMany({
            where: { id: orderId },
            data: { periodStart: period.periodStart, periodEnd: period.periodEnd },
          });
          // Janela de uso do período novo (a da âncora; antes da âncora devolve a própria âncora).
          const windowStart = usageWindowStart(
            now,
            period.periodStart,
            subscriptionWindows({
              status: 'ACTIVE',
              currentPeriodStart: period.periodStart,
              currentPeriodEnd: period.periodEnd,
            }),
          );
          await tx.usageCounter.createMany({
            data: [{ subscriptionId: subscription.id, windowStart }],
            skipDuplicates: true,
          });
          return {
            granted: true,
            subscriptionId: subscription.id,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
          };
        },
        { maxWait: 30_000, timeout: 30_000 },
      );
    });
  }

  markFailed(orderId: string): Promise<void> {
    return withRepositoryErrors('Checkout.markFailed', async () => {
      if (!isUuid(orderId)) return;
      await this.db.paymentOrder.updateMany({
        where: { id: orderId, status: { in: [...GRANTABLE] } },
        data: { status: 'FAILED' },
      });
    });
  }

  claimForReconciliation(now: Date, staleBefore: Date, limit: number): Promise<readonly string[]> {
    return withRepositoryErrors('Checkout.claimForReconciliation', async () => {
      const since = new Date(now.getTime() - RECONCILE_WINDOW_MS);
      // CTE MATERIALIZED + SKIP LOCKED: duas instâncias nunca pegam o mesmo pedido, e a marca
      // last_checked_at evita reconsultar o que acabou de ser conferido. Só ids saem.
      const rows = await this.db.$queryRaw<{ id: string }[]>`
        WITH picked AS MATERIALIZED (
          SELECT id FROM payment_orders
          WHERE status = 'PENDING'
            AND created_at >= ${since}::timestamptz
            AND (last_checked_at IS NULL OR last_checked_at < ${staleBefore}::timestamptz)
          ORDER BY created_at
          LIMIT ${limit}::int
          FOR UPDATE SKIP LOCKED)
        UPDATE payment_orders
        SET last_checked_at = ${now}::timestamptz
        WHERE id IN (SELECT id FROM picked) AND status = 'PENDING'
        RETURNING id::text AS id`;
      return rows.map((row) => row.id);
    });
  }

  expireIfDue(orderId: string, now: Date): Promise<boolean> {
    return withRepositoryErrors('Checkout.expireIfDue', async () => {
      if (!isUuid(orderId)) return false;
      const { count } = await this.db.paymentOrder.updateMany({
        where: { id: orderId, status: 'PENDING', expiresAt: { lte: now } },
        data: { status: 'EXPIRED' },
      });
      return count > 0;
    });
  }
}
