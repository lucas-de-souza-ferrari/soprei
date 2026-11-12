import type {
  CompanyId,
  ListOptions,
  Message,
  MessageOrder,
  MessageRepository,
  MessageSentMark,
  MessageUpdate,
  NewMessage,
  Page,
} from '../../../domain/index.js';
import type { Message as MessageRow } from '../../../generated/prisma/client.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import { isUuid } from '../../../shared/utils/index.js';
import {
  buildDescPageQuery,
  buildPageQuery,
  descOrderBy,
  stableOrderBy,
  toPage,
} from './cursor.js';
import { toMessage } from './mappers.js';
import { PrismaTenantRepository, type TenantModelOps } from './tenant.repository.base.js';
import type { TenantScopedDb } from '../extensions/tenant-scope.js';

function messageOps(db: TenantScopedDb): TenantModelOps<MessageRow, NewMessage, MessageUpdate> {
  return {
    findFirst: (where) => db.message.findFirst({ where }),
    findMany: ({ where, orderBy, take }) => db.message.findMany({ where, orderBy, take }),
    create: async (data) => {
      const row = await db.message.create({
        data: {
          companyId: data.companyId,
          conversationId: data.conversationId,
          role: data.role,
          content: data.content,
          ...(data.isFallback === undefined ? {} : { isFallback: data.isFallback }),
          ...(data.externalId === undefined ? {} : { externalId: data.externalId }),
          ...(data.replyToId === undefined ? {} : { replyToId: data.replyToId }),
          ...(data.createdAt === undefined ? {} : { createdAt: data.createdAt }),
        },
      });
      // Última atividade da conversa (spec 024), na mesma transação quando há uma: o `updatedAt`
      // só avança (nunca volta) até o instante da mensagem. O `where` leva a empresa, como sempre.
      await db.conversation.updateMany({
        where: {
          companyId: data.companyId,
          id: data.conversationId,
          updatedAt: { lt: row.createdAt },
        },
        data: { updatedAt: row.createdAt },
      });
      return row;
    },
    // Mensagens são imutáveis: "atualizar" só confirma que a mensagem existe nesta empresa.
    updateMany: async (where) => ({ count: await db.message.count({ where }) }),
    deleteMany: (where) => db.message.deleteMany({ where }),
    count: (where) => db.message.count({ where }),
  };
}

/**
 * Repositório de `Message` sobre a base de tenant: o filtro por empresa é montado pela base
 * (`findById`, `list`, `create`...) e, nos métodos próprios, sempre com `companyId` no `where`
 * (a `tenant-scope` recusa qualquer consulta sem ele).
 */
export class PrismaMessageRepository
  extends PrismaTenantRepository<MessageRow, Message, NewMessage, MessageUpdate>
  implements MessageRepository
{
  constructor(private readonly db: TenantScopedDb) {
    super({ entity: 'Message', ops: messageOps(db), map: toMessage });
  }

  forTransaction(tx: TenantScopedDb): PrismaMessageRepository {
    return new PrismaMessageRepository(tx);
  }

  findByExternalId(companyId: CompanyId, externalId: string): Promise<Message | null> {
    return this.run('findByExternalId', async () => {
      const row = await this.db.message.findFirst({ where: { companyId, externalId } });
      return row === null ? null : toMessage(row);
    });
  }

  findReplyTo(companyId: CompanyId, messageId: string): Promise<Message | null> {
    return this.run('findReplyTo', async () => {
      if (!isUuid(messageId)) return null;
      const row = await this.db.message.findFirst({
        where: { companyId, replyToId: messageId, role: 'ASSISTANT' },
      });
      return row === null ? null : toMessage(row);
    });
  }

  listRecent(
    companyId: CompanyId,
    conversationId: string,
    limit: number,
  ): Promise<readonly Message[]> {
    return this.run('listRecent', async () => {
      if (!Number.isInteger(limit) || limit < 1 || !isUuid(conversationId)) return [];
      const rows = await this.db.message.findMany({
        where: { companyId, conversationId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      });
      return rows.reverse().map(toMessage);
    });
  }

  listBefore(
    companyId: CompanyId,
    conversationId: string,
    messageId: string,
    limit: number,
  ): Promise<readonly Message[]> {
    return this.run('listBefore', async () => {
      if (!Number.isInteger(limit) || limit < 1 || !isUuid(conversationId) || !isUuid(messageId)) {
        return [];
      }
      // A âncora precisa ser DESTA conversa e Desta empresa; senão não há "anterior" a ela.
      const anchor = await this.db.message.findFirst({
        where: { companyId, conversationId, id: messageId },
      });
      if (anchor === null) return [];
      const rows = await this.db.message.findMany({
        where: {
          companyId,
          conversationId,
          // Antes da âncora na ordem da conversa: `createdAt` e, no mesmo instante, `id`.
          OR: [
            { createdAt: { lt: anchor.createdAt } },
            { createdAt: anchor.createdAt, id: { lt: anchor.id } },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      });
      return rows.reverse().map(toMessage);
    });
  }

  markSent(companyId: CompanyId, messageId: string, mark: MessageSentMark): Promise<boolean> {
    return this.run('markSent', async () => {
      if (!isUuid(messageId)) return false;
      // O `where` carrega a empresa, o papel e a ausência de marca: só a resposta do assistente
      // desta empresa que ainda não foi marcada muda (idempotente; mensagem alheia é intocável).
      const { count } = await this.db.message.updateMany({
        where: { companyId, id: messageId, role: 'ASSISTANT', sentAt: null },
        data: { channelMessageId: mark.channelMessageId, sentAt: mark.sentAt },
      });
      return count > 0;
    });
  }

  listPending(
    companyId: CompanyId,
    conversationId: string,
    limit: number,
  ): Promise<readonly Message[]> {
    return this.run('listPending', async () => {
      if (!Number.isInteger(limit) || limit < 1 || !isUuid(conversationId)) return [];
      // Spec 039: o que a equipe já tratou pelo celular (até `aiIgnoreBefore`) não está pendente.
      const conversation = await this.db.conversation.findFirst({
        where: { companyId, id: conversationId },
        select: { aiIgnoreBefore: true },
      });
      if (conversation === null) return [];
      const ignoreBefore = conversation.aiIgnoreBefore;
      const rows = await this.db.message.findMany({
        where: {
          companyId,
          conversationId,
          role: 'USER',
          answeredById: null,
          ...(ignoreBefore === null ? {} : { createdAt: { gt: ignoreBefore } }),
          // Sem resposta pelo caminho de uma resposta por mensagem (simulador e dados antigos).
          replies: { none: {} },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
      });
      return rows.map(toMessage);
    });
  }

  findByChannelMessageId(companyId: CompanyId, channelMessageId: string): Promise<Message | null> {
    return this.run('findByChannelMessageId', async () => {
      const row = await this.db.message.findFirst({
        where: { companyId, channelMessageId, role: 'ASSISTANT' },
      });
      return row === null ? null : toMessage(row);
    });
  }

  markAnswered(
    companyId: CompanyId,
    messageIds: readonly string[],
    replyId: string,
  ): Promise<number> {
    return this.run('markAnswered', async () => {
      const ids = messageIds.filter(isUuid);
      if (ids.length === 0 || !isUuid(replyId)) return 0;
      // O `where` carrega a empresa, o papel e a ausência de marca: só mensagem do contato deste
      // empresa que ainda não foi atendida muda (idempotente; id de outra empresa é intocável). A
      // chave estrangeira composta garante, no banco, que a resposta é do mesma empresa.
      const { count } = await this.db.message.updateMany({
        where: { companyId, id: { in: ids }, role: 'USER', answeredById: null },
        data: { answeredById: replyId },
      });
      return count;
    });
  }

  listByConversation(
    companyId: CompanyId,
    conversationId: string,
    options?: ListOptions,
    order: MessageOrder = 'asc',
  ): Promise<Page<Message>> {
    return this.run('listByConversation', async () => {
      if (!isUuid(conversationId)) {
        throw new NotFoundError('Recurso não encontrado', { context: { entity: 'Conversation' } });
      }
      if (order === 'desc') {
        const { limit, take, after } = buildDescPageQuery(options);
        const rows = await this.db.message.findMany({
          where: { companyId, conversationId, ...(after === undefined ? {} : { OR: after }) },
          orderBy: descOrderBy(),
          take,
        });
        return toPage(rows, limit, toMessage);
      }
      const { limit, take, after } = buildPageQuery(options);
      const rows = await this.db.message.findMany({
        where: { companyId, conversationId, ...(after === undefined ? {} : { OR: after }) },
        orderBy: stableOrderBy(),
        take,
      });
      return toPage(rows, limit, toMessage);
    });
  }
}
