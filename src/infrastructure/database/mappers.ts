import { type Client, ClientId, type Conversation, type Message } from '../../domain/index.js';
import type {
  Client as ClientRow,
  Conversation as ConversationRow,
  Message as MessageRow,
} from '../../generated/prisma/client.js';

/** Linha do Prisma para entidade de domínio. Nada do Prisma sai desta pasta. */
export function toClient(row: ClientRow): Client {
  return {
    id: ClientId.parse(row.id),
    name: row.name,
    slug: row.slug,
    // O enum do Prisma e o tipo do domínio têm os mesmos valores: o compilador confere.
    status: row.status,
    persona: row.persona,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    clientId: ClientId.parse(row.clientId),
    contactRef: row.contactRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    clientId: ClientId.parse(row.clientId),
    conversationId: row.conversationId,
    // O enum do Prisma e o tipo do domínio têm os mesmos valores: o compilador confere.
    role: row.role,
    content: row.content,
    isFallback: row.isFallback,
    externalId: row.externalId,
    replyToId: row.replyToId,
    createdAt: row.createdAt,
  };
}
