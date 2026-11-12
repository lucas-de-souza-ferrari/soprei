import type { CompanyId } from '../../../domain/index.js';
import type {
  OnboardingFacts,
  OnboardingFactsWanted,
  OnboardingStore,
} from '../../../application/ports/onboarding-store.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import type { TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { withRepositoryErrors } from './repository-errors.js';

/**
 * Estado do assistente de primeiros passos (spec 030). `Company` é model global (raiz do tenant) e
 * as demais leituras são de models de tenant com `companyId` em todo `where` (a `tenant-scope` recusa o
 * que escapar). Só `findFirst`/`updateMany`; nenhum SQL cru. O texto da persona é lido apenas para
 * saber se existe (`!== null`) e nunca sai daqui.
 */
export class PrismaOnboardingStore implements OnboardingStore {
  constructor(private readonly db: TenantScopedPrisma) {}

  read(companyId: CompanyId, wanted: OnboardingFactsWanted): Promise<OnboardingFacts> {
    return withRepositoryErrors('Onboarding.read', async () => {
      const company = await this.db.company.findFirst({
        where: { id: companyId, deletedAt: null },
        select: { onboardingDismissedAt: true, persona: wanted.persona },
      });
      if (company === null) throw notFound();
      const [knowledge, schedule, inventory] = await Promise.all([
        wanted.knowledge
          ? this.db.knowledgeDocument.findFirst({ where: { companyId }, select: { id: true } })
          : null,
        wanted.schedule
          ? this.db.scheduleService.findFirst({
              where: { companyId, active: true },
              select: { id: true },
            })
          : null,
        wanted.inventory
          ? this.db.product.findFirst({ where: { companyId, active: true }, select: { id: true } })
          : null,
      ]);
      return {
        dismissed: company.onboardingDismissedAt !== null,
        persona: wanted.persona && 'persona' in company && company.persona !== null,
        knowledge: knowledge !== null,
        schedule: schedule !== null,
        inventory: inventory !== null,
      };
    });
  }

  setDismissed(companyId: CompanyId, dismissed: boolean): Promise<boolean> {
    return withRepositoryErrors('Onboarding.setDismissed', async () => {
      // Uma única escrita, condicional ao estado atual: dispensar de novo não muda a data e reabrir de
      // novo não faz nada (idempotente); a contagem diz se mudou.
      const { count } = await this.db.company.updateMany({
        where: {
          id: companyId,
          deletedAt: null,
          onboardingDismissedAt: dismissed ? null : { not: null },
        },
        data: { onboardingDismissedAt: dismissed ? new Date() : null },
      });
      if (count > 0) return true;
      const exists = await this.db.company.findFirst({
        where: { id: companyId, deletedAt: null },
        select: { id: true },
      });
      if (exists === null) throw notFound();
      return false;
    });
  }
}

function notFound(): NotFoundError {
  return new NotFoundError('Empresa não encontrada', { context: { entity: 'Company' } });
}
