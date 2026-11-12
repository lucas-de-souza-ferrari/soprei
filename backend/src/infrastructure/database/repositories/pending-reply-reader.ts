import type {
  PendingReplyReader,
  PendingReplyTarget,
} from '../../../application/ports/pending-reply-reader.js';
import { isUuid } from '../../../shared/utils/index.js';
import type { TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { withRepositoryErrors } from './repository-errors.js';

/** Teto de empresas varridas por assinatura (o maior plano tem 10; folga de defesa). */
const MAX_COMPANIES = 20;

/**
 * Contatos com mensagem pendente nas empresas de uma assinatura (spec 031, E3). Parte das empresas da
 * assinatura (model global) e, para cada uma, consulta conversas e mensagens com o `companyId` no
 * `where` (barreira de tenant). Só ids e a referência do contato, que vai ao job de flush e nunca a log.
 * Pendente = mensagem do contato sem marca de atendida e sem resposta (mesma definição da spec 013).
 */
export class PrismaPendingReplyReader implements PendingReplyReader {
  constructor(private readonly db: TenantScopedPrisma) {}

  listForSubscription(
    subscriptionId: string,
    limit: number,
  ): Promise<readonly PendingReplyTarget[]> {
    return withRepositoryErrors('PendingReplies.listForSubscription', async () => {
      if (!isUuid(subscriptionId) || limit < 1) return [];
      const companies = await this.db.company.findMany({
        where: {
          subscriptionId,
          deletedAt: null,
          status: 'ACTIVE',
          whatsappPhoneNumberId: { not: null },
        },
        select: { id: true, whatsappPhoneNumberId: true },
        orderBy: { id: 'asc' },
        take: MAX_COMPANIES,
      });
      const targets: PendingReplyTarget[] = [];
      for (const company of companies) {
        const phoneNumberId = company.whatsappPhoneNumberId;
        if (phoneNumberId === null || targets.length >= limit) continue;
        const conversations = await this.db.conversation.findMany({
          where: {
            companyId: company.id,
            messages: {
              some: {
                companyId: company.id,
                role: 'USER',
                answeredById: null,
                replies: { none: {} },
              },
            },
          },
          select: { contactRef: true },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: limit - targets.length,
        });
        for (const conversation of conversations) {
          targets.push({
            companyId: company.id,
            phoneNumberId,
            contactRef: conversation.contactRef,
          });
        }
      }
      return targets;
    });
  }
}
