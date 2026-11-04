import type {
  CompanyId,
  Conversation,
  ConversationRepository,
  ConversationUpdate,
  ListOptions,
  NewConversation,
  Page,
} from '../../../domain/index.js';
import type { Conversation as ConversationRow } from '../../../generated/prisma/client.js';
import { DatabaseError } from '../../../shared/errors/index.js';
import { activityOrderBy, buildActivityPageQuery, toActivityPage } from './cursor.js';
import { toConversation } from './mappers.js';
import { PrismaTenantRepository, type TenantModelOps } from './tenant.repository.base.js';
import type { TenantScopedDb } from '../extensions/tenant-scope.js';

function conversationOps(
  db: TenantScopedDb,
): TenantModelOps<ConversationRow, NewConversation, ConversationUpdate> {
  return {
    findFirst: (where) => db.conversation.findFirst({ where }),
    findMany: ({ where, orderBy, take }) => db.conversation.findMany({ where, orderBy, take }),
    create: (data) =>
      db.conversation.create({ data: { companyId: data.companyId, contactRef: data.contactRef } }),
    // Ainda não há campos editáveis: por ora, atualizar só marca o registro como alterado.
    updateMany: (where) => db.conversation.updateMany({ where, data: { updatedAt: new Date() } }),
    deleteMany: (where) => db.conversation.deleteMany({ where }),
    count: (where) => db.conversation.count({ where }),
  };
}

export class PrismaConversationRepository
  extends PrismaTenantRepository<ConversationRow, Conversation, NewConversation, ConversationUpdate>
  implements ConversationRepository
{
  constructor(private readonly db: TenantScopedDb) {
    super({ entity: 'Conversation', ops: conversationOps(db), map: toConversation });
  }

  forTransaction(tx: TenantScopedDb): ConversationRepository {
    return new PrismaConversationRepository(tx);
  }

  findByContact(companyId: CompanyId, contactRef: string): Promise<Conversation | null> {
    return this.run('findByContact', async () => {
      const row = await this.db.conversation.findFirst({ where: { companyId, contactRef } });
      return row === null ? null : toConversation(row);
    });
  }

  listByActivity(companyId: CompanyId, options?: ListOptions): Promise<Page<Conversation>> {
    return this.run('listByActivity', async () => {
      const { limit, take, after } = buildActivityPageQuery(options);
      const rows = await this.db.conversation.findMany({
        where: { companyId, ...(after === undefined ? {} : { OR: after }) },
        orderBy: activityOrderBy(),
        take,
      });
      return toActivityPage(rows, limit, toConversation);
    });
  }

  findOrCreateByContact(companyId: CompanyId, contactRef: string): Promise<Conversation> {
    return this.run('findOrCreateByContact', async () => {
      const where = { companyId, contactRef };
      const existing = await this.db.conversation.findFirst({ where });
      if (existing !== null) return toConversation(existing);
      // `skipDuplicates` vira INSERT ... ON CONFLICT DO NOTHING: o pedido concorrente que
      // perde a corrida não falha (e, dentro de uma transação, não a deixa abortada); em
      // seguida os dois leem a mesma linha, que a unicidade (companyId, contactRef) garante.
      await this.db.conversation.createMany({
        data: [{ companyId, contactRef }],
        skipDuplicates: true,
      });
      const row = await this.db.conversation.findFirst({ where });
      if (row === null) {
        throw new DatabaseError('Conversa não encontrada após a criação', {
          context: { entity: 'Conversation' },
        });
      }
      return toConversation(row);
    });
  }
}
