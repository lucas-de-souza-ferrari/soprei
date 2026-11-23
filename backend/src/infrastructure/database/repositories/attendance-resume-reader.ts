import type {
  ResumeScan,
  ResumeScanOptions,
  ResumeTarget,
  ResumeTargetReader,
} from '../../../application/ports/attendance-resume.js';
import { SITE_TEST_CONTACT_REF } from '../../../application/attendance/contact-label.js';
import { isUuid } from '../../../shared/utils/index.js';
import type { TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { withRepositoryErrors } from './repository-errors.js';

/**
 * Quem ficou sem resposta no canal (spec 035). É o segundo ponto que percorre as empresas (o primeiro
 * é o `PrismaPendingReplyReader`, por assinatura): parte de `companies` (model global) e, para cada
 * empresa, consulta conversas e mensagens **com o `companyId` no `where`**, pela barreira de tenant.
 * Sem SQL cru. Só ids, o número da empresa e a referência do contato, que vai ao job de `flush` e
 * nunca a log.
 *
 * Empresas: ativas, não removidas, com número conectado e sem conexão em `TOKEN_INVALID`, em ordem de
 * id a partir do cursor (rodízio). Conversas: IA não pausada, fora o contato fixo do teste do site, e
 * com mensagem do contato dentro da janela.
 */
export class PrismaResumeTargetReader implements ResumeTargetReader {
  constructor(private readonly db: TenantScopedPrisma) {}

  scan(options: ResumeScanOptions): Promise<ResumeScan> {
    return withRepositoryErrors('AttendanceResume.scan', async () => {
      const { now, maxCompanies, maxContactsPerCompany } = options;
      if (maxCompanies < 1 || maxContactsPerCompany < 1)
        return { targets: [], nextCompanyId: null };
      const after =
        options.afterCompanyId !== null && isUuid(options.afterCompanyId)
          ? options.afterCompanyId
          : null;
      const stalledBefore = new Date(now.getTime() - options.minAgeMs);
      const windowStart = new Date(now.getTime() - options.windowMs);

      const companies = await this.db.company.findMany({
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          whatsappPhoneNumberId: { not: null },
          // Sem conexão é o modo legado (token global); com conexão, só a que a Meta ainda aceita.
          OR: [{ channelConnection: null }, { channelConnection: { status: 'CONNECTED' } }],
          ...(after === null ? {} : { id: { gt: after } }),
        },
        select: { id: true, whatsappPhoneNumberId: true },
        orderBy: { id: 'asc' },
        take: maxCompanies,
      });

      const targets: ResumeTarget[] = [];
      for (const company of companies) {
        const phoneNumberId = company.whatsappPhoneNumberId;
        if (phoneNumberId === null) continue;
        const companyId = company.id;
        // Comum aos dois tipos: IA não pausada, não é o teste do site, e o contato escreveu dentro da
        // janela de atendimento do canal.
        const eligible = {
          companyId,
          contactRef: { not: SITE_TEST_CONTACT_REF },
          OR: [{ aiPausedUntil: null }, { aiPausedUntil: { lte: now } }],
        };
        const contactInWindow = {
          messages: { some: { companyId, role: 'USER' as const, createdAt: { gt: windowStart } } },
        };

        const pending = await this.db.conversation.findMany({
          where: {
            ...eligible,
            AND: [
              contactInWindow,
              {
                messages: {
                  some: {
                    companyId,
                    role: 'USER',
                    answeredById: null,
                    replies: { none: {} },
                    createdAt: { lte: stalledBefore },
                  },
                },
              },
            ],
          },
          select: { id: true, contactRef: true },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: maxContactsPerCompany,
        });
        const seen = new Set<string>();
        for (const conversation of pending) {
          seen.add(conversation.id);
          targets.push({
            companyId,
            phoneNumberId,
            contactRef: conversation.contactRef,
            kind: 'pending',
          });
        }

        // Resposta gravada e não enviada: só vale a ÚLTIMA mensagem da conversa (é a que o `flush`
        // reenvia), e nunca a que a equipe segurou ao assumir a conversa (`aiIgnoreBefore`, spec 039).
        const unsent = await this.db.conversation.findMany({
          where: {
            ...eligible,
            AND: [
              contactInWindow,
              {
                messages: {
                  some: {
                    companyId,
                    role: 'ASSISTANT',
                    sentAt: null,
                    createdAt: { lte: stalledBefore, gt: windowStart },
                  },
                },
              },
            ],
          },
          select: {
            id: true,
            contactRef: true,
            aiIgnoreBefore: true,
            messages: {
              where: { companyId },
              select: { role: true, sentAt: true, createdAt: true },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 1,
            },
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: maxContactsPerCompany,
        });
        for (const conversation of unsent) {
          if (seen.has(conversation.id)) continue;
          const [last] = conversation.messages;
          if (last === undefined || last.role !== 'ASSISTANT' || last.sentAt !== null) continue;
          if (last.createdAt.getTime() > stalledBefore.getTime()) continue;
          if (
            conversation.aiIgnoreBefore !== null &&
            last.createdAt.getTime() <= conversation.aiIgnoreBefore.getTime()
          ) {
            continue;
          }
          targets.push({
            companyId,
            phoneNumberId,
            contactRef: conversation.contactRef,
            kind: 'unsent',
          });
        }
      }

      const lastCompany = companies[companies.length - 1];
      return {
        targets,
        // Página cheia: pode haver mais empresas; a próxima execução continua depois da última lida.
        nextCompanyId:
          companies.length === maxCompanies && lastCompany !== undefined ? lastCompany.id : null,
      };
    });
  }
}
