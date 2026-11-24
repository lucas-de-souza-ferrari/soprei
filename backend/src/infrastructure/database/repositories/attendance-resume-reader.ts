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
          // Sem conexão é o modo legado (token global, só se configurado); com conexão, só a que a Meta
          // ainda aceita (revisão da 035, S6: sem token global, o `flush` chamaria o modelo e não enviaria).
          OR: [
            ...(options.includeLegacy ? [{ channelConnection: null }] : []),
            { channelConnection: { status: 'CONNECTED' as const } },
          ],
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
        // `updatedAt` acompanha a última mensagem (spec 024): o filtro é exato e usa o índice
        // `(company_id, updated_at, id)` (revisão da 035, S2).
        const eligible = {
          companyId,
          contactRef: { not: SITE_TEST_CONTACT_REF },
          updatedAt: { gt: windowStart },
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
          select: {
            id: true,
            contactRef: true,
            aiIgnoreBefore: true,
            // A pendente mais nova: se a equipe já tratou até ela, nada do contato está realmente pendente.
            messages: {
              where: { companyId, role: 'USER', answeredById: null, replies: { none: {} } },
              select: { createdAt: true },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 1,
            },
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: maxContactsPerCompany,
        });
        const seen = new Set<string>();
        for (const conversation of pending) {
          // Revisão da 035 (I3): o que a equipe tratou pelo celular (`aiIgnoreBefore`, spec 039) nunca é
          // respondido pela IA; sem isto o contato gastaria as tentativas do dia à toa.
          const [newest] = conversation.messages;
          if (
            newest === undefined ||
            (conversation.aiIgnoreBefore !== null &&
              newest.createdAt.getTime() <= conversation.aiIgnoreBefore.getTime())
          ) {
            continue;
          }
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
                    deliveryUncertainAt: null,
                    // Só resposta que atendeu um lote do canal; a do simulador nunca (revisão, I1).
                    answers: { some: { companyId } },
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
              select: {
                role: true,
                sentAt: true,
                createdAt: true,
                isFallback: true,
                deliveryUncertainAt: true,
                answers: { where: { companyId }, select: { id: true }, take: 1 },
              },
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
          // O texto padrão de falha nunca é reenviado (D4; revisão da 035, S5); nem a resposta que a
          // Meta aceitou sem devolver o id (I4); nem a que não atendeu lote do canal, a do simulador (I1).
          if (last.isFallback || last.deliveryUncertainAt !== null || last.answers.length === 0) {
            continue;
          }
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
