import type {
  Conversation,
  ConversationRepository,
  ConversationUpdate,
  NewConversation,
} from '../../domain/index.js';
import type { Conversation as ConversationRow } from '../../generated/prisma/client.js';
import { toConversation } from './mappers.js';
import { PrismaTenantRepository, type TenantModelOps } from './tenant.repository.base.js';
import type { TenantScopedDb } from './tenant-scope.js';

function conversationOps(
  db: TenantScopedDb,
): TenantModelOps<ConversationRow, NewConversation, ConversationUpdate> {
  return {
    findFirst: (where) => db.conversation.findFirst({ where }),
    findMany: ({ where, orderBy, take }) => db.conversation.findMany({ where, orderBy, take }),
    create: (data) => db.conversation.create({ data: { clientId: data.clientId } }),
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
  constructor(db: TenantScopedDb) {
    super({ entity: 'Conversation', ops: conversationOps(db), map: toConversation });
  }

  forTransaction(tx: TenantScopedDb): ConversationRepository {
    return new PrismaConversationRepository(tx);
  }
}
