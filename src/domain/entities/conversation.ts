import type { ClientId } from '../value-objects/client-id.js';

/** Conversa de um cliente. Mínima por ora: os campos reais vêm em specs futuras. */
export interface Conversation {
  readonly id: string;
  readonly clientId: ClientId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Dados de criação. Não há `clientId` aqui: ele vem sempre do parâmetro do repositório. */
export type NewConversation = Readonly<Record<string, never>>;

/** Dados de atualização (ainda sem campos editáveis). */
export type ConversationUpdate = Readonly<Record<string, never>>;
