import {
  type AuditEvent,
  type ChannelConnection,
  type Client,
  ClientId,
  type Conversation,
  type Message,
  type PlatformAdmin,
  PlatformAdminId,
  type User,
  UserId,
} from '../../../domain/index.js';
import type {
  AuditEvent as AuditEventRow,
  ChannelConnection as ChannelConnectionRow,
  Client as ClientRow,
  Conversation as ConversationRow,
  Message as MessageRow,
  PlatformAdmin as PlatformAdminRow,
  User as UserRow,
} from '../../../generated/prisma/client.js';

/** Linha do Prisma para entidade de domínio. Nada do Prisma sai desta pasta. */
export function toClient(row: ClientRow): Client {
  return {
    id: ClientId.parse(row.id),
    name: row.name,
    slug: row.slug,
    // O enum do Prisma e o tipo do domínio têm os mesmos valores: o compilador confere.
    status: row.status,
    persona: row.persona,
    whatsappPhoneNumberId: row.whatsappPhoneNumberId,
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
    channelMessageId: row.channelMessageId,
    sentAt: row.sentAt,
    answeredById: row.answeredById,
  };
}

/** Linha para entidade: o `passwordHash` fica de fora de propósito (só `UserCredentials` o leva). */
export function toUser(row: UserRow): User {
  return {
    id: UserId.parse(row.id),
    clientId: ClientId.parse(row.clientId),
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPlatformAdmin(row: PlatformAdminRow): PlatformAdmin {
  return {
    id: PlatformAdminId.parse(row.id),
    email: row.email,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    clientId: ClientId.parse(row.clientId),
    action: row.action,
    actorUserId: row.actorUserId,
    targetUserId: row.targetUserId,
    fromRole: row.fromRole,
    toRole: row.toRole,
    createdAt: row.createdAt,
  };
}

/** Linha para entidade. O texto cifrado fica na entidade (só o serviço de credenciais o decifra). */
export function toChannelConnection(row: ChannelConnectionRow): ChannelConnection {
  return {
    id: row.id,
    clientId: ClientId.parse(row.clientId),
    wabaId: row.wabaId,
    tokenCiphertext: row.tokenCiphertext,
    registrationPinCiphertext: row.registrationPinCiphertext,
    tokenVersion: row.tokenVersion,
    status: row.status,
    tokenExpiresAt: row.tokenExpiresAt,
    tokenInvalidAt: row.tokenInvalidAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
