import type {
  PlatformSubscriptionTransaction,
  PlatformSubscriptionUnitOfWork,
} from '../../../application/ports/platform-subscription-unit-of-work.js';
import { RECONCILE_WINDOW_MS } from '../../../domain/index.js';
import { Prisma } from '../../../generated/prisma/client.js';
import type { TenantScopedDb, TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { isDeadlock } from '../database-errors.js';
import { runInTransaction, type TransactionOptions } from '../transaction.js';
import { lockAccountRow, lockOwnedCompanies } from './account.repository.js';
import {
  ensureTrialSubscription,
  findSubscriptionByAccount,
  readCatalog,
} from './billing.repository.js';
import { lockSubscriptionRow } from './checkout.repository.js';
import { PrismaPlatformAuditRepository } from './platform-audit.repository.js';

/**
 * Há pedido desta assinatura que ainda pode virar pagamento concedido? Revisão da E4 (I1), o mesmo critério
 * da reconciliação: `PENDING`, ou `EXPIRED` com link (substituído, mas o link do provedor segue pagável),
 * criado dentro da janela da reconciliação. Usado pelas ações da E4 e pela remoção da conta (E6).
 */
export async function hasPayableOrder(
  db: TenantScopedDb,
  subscriptionId: string,
  now: Date,
): Promise<boolean> {
  const count = await db.paymentOrder.count({
    where: {
      subscriptionId,
      createdAt: { gte: new Date(now.getTime() - RECONCILE_WINDOW_MS) },
      OR: [{ status: 'PENDING' }, { status: 'EXPIRED', checkoutUrl: { not: null } }],
    },
  });
  return count > 0;
}

/** Repetições depois de um deadlock (a primeira tentativa não conta), como a unidade de trabalho da E2. */
const DEADLOCK_RETRIES = 2;

/**
 * Ações do admin da plataforma sobre a assinatura de uma conta (spec 045, E4). Travas na ordem empresas ->
 * conta -> assinatura (regra comum 4). Sem SQL cru novo: as travas são as que já existem (`lockCompanyRow`
 * via `lockOwnedCompanies`, `lockAccountRow` e a da assinatura do checkout, `lockSubscriptionRow`), o teste
 * gratuito é o `ensureTrialSubscription` da 031 e o catálogo é o `readCatalog` (só o modo "a empresa paga a
 * Meta"). `Subscription`, `PaymentOrder`, `Plan` e `PlanPrice` são models globais; as empresas adotadas são
 * achadas pela relação com o vínculo `OWNER` da conta, como no `createCompany` da 031.
 */
export class PrismaPlatformSubscriptionUnitOfWork implements PlatformSubscriptionUnitOfWork {
  constructor(
    private readonly prisma: TenantScopedPrisma,
    private readonly options: TransactionOptions = {},
  ) {}

  async run<T>(fn: (tx: PlatformSubscriptionTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(fn);
      } catch (error) {
        if (attempt >= DEADLOCK_RETRIES || !isDeadlock(error)) throw error;
      }
    }
  }

  private once<T>(fn: (tx: PlatformSubscriptionTransaction) => Promise<T>): Promise<T> {
    return runInTransaction(
      this.prisma,
      (db) => {
        const audit = new PrismaPlatformAuditRepository(db);
        return fn({
          lockOwnedCompanies: (accountId) => lockOwnedCompanies(db, accountId),
          lockAccount: async (accountId) => {
            if (!(await lockAccountRow(db, accountId))) return null;
            const row = await db.account.findFirst({
              where: { id: accountId },
              select: { status: true, emailVerifiedAt: true },
            });
            return row === null
              ? null
              : { status: row.status, verified: row.emailVerifiedAt !== null };
          },
          lockSubscription: async (accountId) => {
            const found = await db.subscription.findFirst({
              where: { accountId },
              select: { id: true },
            });
            if (found === null) return null;
            await lockSubscriptionRow(db, found.id);
            return findSubscriptionByAccount(db, accountId);
          },
          hasPendingOrder: (subscriptionId, now) => hasPayableOrder(db, subscriptionId, now),
          startTrial: async (accountId, now, trialDays) => {
            const subscription = await ensureTrialSubscription(db, accountId, now, { trialDays });
            const { count } = await db.company.updateMany({
              where: {
                subscriptionId: null,
                deletedAt: null,
                memberships: { some: { accountId, role: 'OWNER', status: 'ACTIVE' } },
              },
              data: { subscriptionId: subscription.id },
            });
            return count;
          },
          planTarget: async (planCode, cycle, now) => {
            const entry = (await readCatalog(db, now, false)).find(
              (item) => item.plan.code === planCode,
            );
            const price = entry?.prices.find((item) => item.cycle === cycle);
            if (entry === undefined || price === undefined) return null;
            return {
              planId: entry.plan.id,
              priceId: price.id,
              maxCompanies: entry.plan.maxCompanies,
            };
          },
          countCompanies: (accountId) =>
            db.company.count({
              where: {
                deletedAt: null,
                OR: [
                  { subscription: { accountId } },
                  {
                    subscriptionId: null,
                    memberships: { some: { accountId, role: 'OWNER', status: 'ACTIVE' } },
                  },
                ],
              },
            }),
          update: async (subscriptionId, patch) => {
            await db.subscription.updateMany({
              where: { id: subscriptionId },
              data: {
                ...(patch.status === undefined ? {} : { status: patch.status }),
                ...(patch.currentPeriodEnd === undefined
                  ? {}
                  : { currentPeriodEnd: patch.currentPeriodEnd }),
                ...(patch.trialEndsAt === undefined ? {} : { trialEndsAt: patch.trialEndsAt }),
                ...(patch.cancelAtPeriodEnd === undefined
                  ? {}
                  : { cancelAtPeriodEnd: patch.cancelAtPeriodEnd }),
                ...(patch.agendaEnabled === undefined
                  ? {}
                  : { agendaEnabled: patch.agendaEnabled }),
                ...(patch.stockEnabled === undefined ? {} : { stockEnabled: patch.stockEnabled }),
                ...(patch.planId === undefined ? {} : { planId: patch.planId }),
                ...(patch.priceId === undefined ? {} : { priceId: patch.priceId }),
                ...(patch.clearPendingChange === true ? { pendingChange: Prisma.DbNull } : {}),
              },
            });
          },
          audit: async (event) => {
            await audit.create(event);
          },
        });
      },
      this.options,
    );
  }
}
