import { type Client, ClientId, type Conversation } from '../../domain/index.js';
import type {
  Client as ClientRow,
  Conversation as ConversationRow,
} from '../../generated/prisma/client.js';

/** Linha do Prisma para entidade de domínio. Nada do Prisma sai desta pasta. */
export function toClient(row: ClientRow): Client {
  return {
    id: ClientId.parse(row.id),
    name: row.name,
    slug: row.slug,
    // O enum do Prisma e o tipo do domínio têm os mesmos valores: o compilador confere.
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    clientId: ClientId.parse(row.clientId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
