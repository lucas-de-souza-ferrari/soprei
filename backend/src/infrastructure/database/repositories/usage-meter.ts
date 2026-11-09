import type { UsageMeter } from '../../../application/ports/usage-meter.js';
import type { CompanyId } from '../../../domain/index.js';
import type { TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { withRepositoryErrors } from './repository-errors.js';
import { currentWindowStart } from './billing.repository.js';

/**
 * Medição de uso (spec 031, E2). Resolve `companyId` -> assinatura no servidor (`Company.subscriptionId`
 * via relação) e soma na linha da janela atual com `increment` (atômico, sem SQL cru e sem ler-e-gravar):
 * `updateMany` incrementa; se a linha da janela ainda não existe, `createMany` com `skipDuplicates` a
 * cria e, na corrida (outra instância criou primeiro), incrementa de novo. Só números: nunca texto,
 * contato, conversa nem `contactRef`. Empresa sem assinatura não conta nada (nada a medir).
 */
export class PrismaUsageMeter implements UsageMeter {
  constructor(
    private readonly db: TenantScopedPrisma,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(companyId: CompanyId, tokens: number): Promise<void> {
    const amount = Number.isFinite(tokens) ? Math.floor(tokens) : 0;
    if (amount <= 0) return Promise.resolve();
    return this.add(companyId, amount, 0);
  }

  recordSent(companyId: CompanyId): Promise<void> {
    return this.add(companyId, 0, 1);
  }

  private add(companyId: CompanyId, tokens: number, sent: number): Promise<void> {
    return withRepositoryErrors('UsageMeter.add', async () => {
      const subscription = await this.db.subscription.findFirst({
        where: { companies: { some: { id: companyId, deletedAt: null } } },
        select: { id: true, currentPeriodStart: true, currentPeriodEnd: true, status: true },
      });
      if (subscription === null) return;
      const windowStart = currentWindowStart(subscription, this.now());
      const increments = {
        ...(tokens > 0 ? { tokens: { increment: tokens } } : {}),
        ...(sent > 0 ? { sentMessages: { increment: sent } } : {}),
      };
      const where = { subscriptionId: subscription.id, windowStart };
      if ((await this.db.usageCounter.updateMany({ where, data: increments })).count > 0) return;
      const created = await this.db.usageCounter.createMany({
        data: [{ ...where, tokens: BigInt(tokens), sentMessages: BigInt(sent) }],
        skipDuplicates: true,
      });
      if (created.count === 0) await this.db.usageCounter.updateMany({ where, data: increments });
    });
  }
}
