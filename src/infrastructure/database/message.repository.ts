import type {
  ClientId,
  ListOptions,
  Message,
  MessageRepository,
  MessageUpdate,
  NewMessage,
  Page,
} from '../../domain/index.js';
import type { Message as MessageRow } from '../../generated/prisma/client.js';
import { NotFoundError } from '../../shared/errors/index.js';
import { isUuid } from '../../shared/utils/index.js';
import { buildPageQuery, stableOrderBy, toPage } from './cursor.js';
import { toMessage } from './mappers.js';
import { PrismaTenantRepository, type TenantModelOps } from './tenant.repository.base.js';
import type { TenantScopedDb } from './tenant-scope.js';

function messageOps(db: TenantScopedDb): TenantModelOps<MessageRow, NewMessage, MessageUpdate> {
  return {
    findFirst: (where) => db.message.findFirst({ where }),
    findMany: ({ where, orderBy, take }) => db.message.findMany({ where, orderBy, take }),
    create: (data) =>
      db.message.create({
        data: {
          clientId: data.clientId,
          conversationId: data.conversationId,
          role: data.role,
          content: data.content,
          ...(data.isFallback === undefined ? {} : { isFallback: data.isFallback }),
          ...(data.externalId === undefined ? {} : { externalId: data.externalId }),
          ...(data.replyToId === undefined ? {} : { replyToId: data.replyToId }),
          ...(data.createdAt === undefined ? {} : { createdAt: data.createdAt }),
        },
      }),
    // Mensagens são imutáveis: "atualizar" só confirma que a mensagem existe neste cliente.
    updateMany: async (where) => ({ count: await db.message.count({ where }) }),
    deleteMany: (where) => db.message.deleteMany({ where }),
    count: (where) => db.message.count({ where }),
  };
}

/**
 * Repositório de `Message` sobre a base de tenant: o filtro por cliente é montado pela base
 * (`findById`, `list`, `create`...) e, nos métodos próprios, sempre com `clientId` no `where`
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

  findByExternalId(clientId: ClientId, externalId: string): Promise<Message | null> {
    return this.run('findByExternalId', async () => {
      const row = await this.db.message.findFirst({ where: { clientId, externalId } });
      return row === null ? null : toMessage(row);
    });
  }

  findReplyTo(clientId: ClientId, messageId: string): Promise<Message | null> {
    return this.run('findReplyTo', async () => {
      if (!isUuid(messageId)) return null;
      const row = await this.db.message.findFirst({
        where: { clientId, replyToId: messageId, role: 'ASSISTANT' },
      });
      return row === null ? null : toMessage(row);
    });
  }

  listRecent(
    clientId: ClientId,
    conversationId: string,
    limit: number,
  ): Promise<readonly Message[]> {
    return this.run('listRecent', async () => {
      if (!Number.isInteger(limit) || limit < 1 || !isUuid(conversationId)) return [];
      const rows = await this.db.message.findMany({
        where: { clientId, conversationId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      });
      return rows.reverse().map(toMessage);
    });
  }

  listByConversation(
    clientId: ClientId,
    conversationId: string,
    options?: ListOptions,
  ): Promise<Page<Message>> {
    return this.run('listByConversation', async () => {
      if (!isUuid(conversationId)) {
        throw new NotFoundError('Recurso não encontrado', { context: { entity: 'Conversation' } });
      }
      const { limit, take, after } = buildPageQuery(options);
      const rows = await this.db.message.findMany({
        where: { clientId, conversationId, ...(after === undefined ? {} : { OR: after }) },
        orderBy: stableOrderBy(),
        take,
      });
      return toPage(rows, limit, toMessage);
    });
  }
}
