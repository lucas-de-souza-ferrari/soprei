import {
  type BillingNoticeKind,
  type BillingNoticeRepository,
  type NoticeCandidate,
  type NoticeRecipient,
  type NoticeTarget,
  type SubscriptionRecord,
} from '../../../domain/index.js';
import { isUuid } from '../../../shared/utils/index.js';
import type { TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { currentWindowStart, toSubscription } from './billing.repository.js';
import { withRepositoryErrors } from './repository-errors.js';

const include = {
  plan: true,
  price: true,
  account: { select: { email: true, status: true, emailVerifiedAt: true } },
} as const;

interface AccountRow {
  readonly email: string;
  readonly status: string;
  readonly emailVerifiedAt: Date | null;
}

/** Só a conta ativa com o e-mail confirmado recebe aviso (o endereço não sai desta camada, a não ser para o envio). */
function recipientOf(account: AccountRow): NoticeRecipient | null {
  return account.status === 'ACTIVE' && account.emailVerifiedAt !== null
    ? { email: account.email }
    : null;
}

/**
 * Avisos de cobrança (spec 031, E5). `Subscription`, `UsageCounter`, `PaymentNotice` e `Account` são models
 * globais: a leitura é sempre por lote de assinaturas (tarefa de sistema) ou pelo id da própria assinatura;
 * nenhuma rota chega aqui. Só `findMany`, `findFirst`, `count`, `createMany`, `deleteMany` e `updateMany`;
 * nenhum SQL cru. A trava de "um aviso por ciclo e tipo" é a chave única de `payment_notices`.
 */
export class PrismaBillingNoticeRepository implements BillingNoticeRepository {
  constructor(private readonly db: TenantScopedPrisma) {}

  listBatch(now: Date, after: string | null, limit: number): Promise<readonly NoticeCandidate[]> {
    return withRepositoryErrors('BillingNotice.listBatch', async () => {
      const rows = await this.db.subscription.findMany({
        where: { status: { not: 'EXPIRED' }, ...(after === null ? {} : { id: { gt: after } }) },
        orderBy: { id: 'asc' },
        take: Math.min(Math.max(1, limit), 500),
        include,
      });
      if (rows.length === 0) return [];
      const subscriptions = rows.map((row) => toSubscription(row));
      const windows = subscriptions.map((subscription) => ({
        subscriptionId: subscription.id,
        windowStart: currentWindowStart(subscription, now),
      }));
      const counters = await this.db.usageCounter.findMany({ where: { OR: windows } });
      const byKey = new Map(
        counters.map((counter) => [
          `${counter.subscriptionId}|${counter.windowStart.toISOString()}`,
          counter,
        ]),
      );
      const out: NoticeCandidate[] = [];
      for (const [index, subscription] of subscriptions.entries()) {
        const row = rows[index];
        const window = windows[index];
        if (row === undefined || window === undefined) continue;
        const counter = byKey.get(`${subscription.id}|${window.windowStart.toISOString()}`);
        // Só a assinatura com troca agendada precisa saber de quantas empresas e de quantas vagas se trata.
        let companies = 0;
        let pendingPlanMaxCompanies: number | null = null;
        if (subscription.pendingChange !== null) {
          const plan = await this.db.plan.findFirst({
            where: { code: subscription.pendingChange.planCode, active: true },
            orderBy: { version: 'desc' },
            select: { maxCompanies: true },
          });
          pendingPlanMaxCompanies = plan?.maxCompanies ?? null;
          companies = await this.db.company.count({
            where: { subscriptionId: subscription.id, deletedAt: null },
          });
        }
        out.push({
          subscription,
          usage: {
            tokens: Number(counter?.tokens ?? 0n),
            sentMessages: Number(counter?.sentMessages ?? 0n),
            extraReplies: counter?.extraReplies ?? 0,
          },
          usageWindowStart: window.windowStart,
          companies,
          pendingPlanMaxCompanies,
          recipient: recipientOf(row.account),
        });
      }
      return out;
    });
  }

  findTarget(subscriptionId: string): Promise<NoticeTarget | null> {
    return withRepositoryErrors('BillingNotice.findTarget', async () => {
      if (!isUuid(subscriptionId)) return null;
      const row = await this.db.subscription.findFirst({ where: { id: subscriptionId }, include });
      return row === null
        ? null
        : { subscription: toSubscription(row), recipient: recipientOf(row.account) };
    });
  }

  claim(subscriptionId: string, kind: BillingNoticeKind, windowStart: Date): Promise<boolean> {
    return withRepositoryErrors('BillingNotice.claim', async () => {
      const created = await this.db.paymentNotice.createMany({
        data: [{ subscriptionId, kind, windowStart }],
        skipDuplicates: true,
      });
      return created.count === 1;
    });
  }

  release(subscriptionId: string, kind: BillingNoticeKind, windowStart: Date): Promise<void> {
    return withRepositoryErrors('BillingNotice.release', async () => {
      await this.db.paymentNotice.deleteMany({ where: { subscriptionId, kind, windowStart } });
    });
  }

  syncStatus(
    subscription: Pick<SubscriptionRecord, 'id' | 'status' | 'currentPeriodEnd'>,
    next: 'PAST_DUE' | 'EXPIRED',
  ): Promise<boolean> {
    return withRepositoryErrors('BillingNotice.syncStatus', async () => {
      // Condicional: se um pagamento renovou o período no meio, a linha já não é a que foi lida e nada muda.
      const updated = await this.db.subscription.updateMany({
        where: {
          id: subscription.id,
          status: subscription.status,
          currentPeriodEnd: subscription.currentPeriodEnd,
        },
        data: { status: next },
      });
      return updated.count === 1;
    });
  }
}
