import type {
  EntitlementReader,
  SubscriptionHolderReader,
} from '../../../application/ports/entitlement-reader.js';
import {
  buildEntitlements,
  type CompanyEntitlements,
  type CompanyId,
  type QuotaSettings,
  type SubscriptionRecord,
  type TrialSettings,
} from '../../../domain/index.js';
import type { TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { withRepositoryErrors } from './repository-errors.js';
import {
  currentWindowStart,
  ensureTrialSubscription,
  findSubscriptionById,
} from './billing.repository.js';

/** Empresa sem assinatura utilizável (órfã ou removida): nada liberado. */
const BLOCKED: CompanyEntitlements = {
  access: 'blocked',
  agenda: false,
  stock: false,
  tokens: null,
  replies: null,
};

export interface EntitlementReaderSettings extends QuotaSettings, TrialSettings {}

/**
 * Entitlements da empresa (spec 031): resolve `companyId` -> `Company.subscriptionId` -> assinatura da
 * conta **no servidor** e deriva acesso, módulos e cotas da janela atual. O `CompanyId` vem só do
 * contexto (token ou job). Duas leituras por turno (empresa com a assinatura e o contador).
 *
 * Empresa sem `subscriptionId` (criada com a cobrança desligada, ou conta anterior à 031) é ADOTADA ao
 * ligar a cobrança: a assinatura da conta da pessoa `OWNER` mais antiga (teste gratuito, uma vez por conta)
 * passa a ser a dela, de forma idempotente (`updateMany` condicional ao `subscriptionId` nulo).
 */
export class PrismaEntitlementReader implements EntitlementReader, SubscriptionHolderReader {
  constructor(
    private readonly db: TenantScopedPrisma,
    private readonly settings: EntitlementReaderSettings,
    private readonly now: () => Date = () => new Date(),
  ) {}

  forCompany(companyId: CompanyId): Promise<CompanyEntitlements> {
    return withRepositoryErrors('Entitlements.forCompany', async () => {
      const now = this.now();
      const company = await this.db.company.findFirst({
        where: { id: companyId, deletedAt: null },
        select: { subscriptionId: true },
      });
      if (company === null) return BLOCKED;
      const subscription =
        company.subscriptionId === null
          ? await this.adopt(companyId, now)
          : await findSubscriptionById(this.db, company.subscriptionId);
      if (subscription === null) return BLOCKED;
      const counter = await this.db.usageCounter.findFirst({
        where: {
          subscriptionId: subscription.id,
          windowStart: currentWindowStart(subscription, now),
        },
      });
      return buildEntitlements(
        subscription,
        {
          tokens: Number(counter?.tokens ?? 0n),
          sentMessages: Number(counter?.sentMessages ?? 0n),
          extraReplies: counter?.extraReplies ?? 0,
        },
        now,
        this.settings,
      );
    });
  }

  holderOf(companyId: CompanyId, membershipId: string): Promise<boolean> {
    return withRepositoryErrors('Entitlements.holderOf', async () => {
      const [membership, company] = await Promise.all([
        this.db.membership.findFirst({
          where: { id: membershipId, companyId },
          select: { accountId: true },
        }),
        this.db.company.findFirst({
          where: { id: companyId, deletedAt: null },
          select: { subscription: { select: { accountId: true } } },
        }),
      ]);
      const holder = company?.subscription?.accountId;
      return (
        membership?.accountId != null && holder !== undefined && holder === membership.accountId
      );
    });
  }

  private async adopt(companyId: CompanyId, now: Date): Promise<SubscriptionRecord | null> {
    const owner = await this.db.membership.findFirst({
      // Só vínculo OWNER ATIVO, de conta ATIVA e com e-mail confirmado: quem foi desativado não herda a
      // empresa nem o teste gratuito.
      where: {
        companyId,
        role: 'OWNER',
        status: 'ACTIVE',
        accountId: { not: null },
        account: { status: 'ACTIVE', emailVerifiedAt: { not: null } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { accountId: true },
    });
    if (owner?.accountId == null) return null;
    const subscription = await ensureTrialSubscription(
      this.db,
      owner.accountId,
      now,
      this.settings,
    );
    await this.db.company.updateMany({
      where: { id: companyId, subscriptionId: null },
      data: { subscriptionId: subscription.id },
    });
    return subscription;
  }
}
