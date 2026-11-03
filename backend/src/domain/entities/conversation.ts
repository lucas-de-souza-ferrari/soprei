import type { WithoutClientId } from '../repositories/tenant.repository.js';
import type { ClientId } from '../value-objects/client-id.js';

/** Limite de caracteres do `contactRef`. */
export const CONTACT_REF_MAX_LENGTH = 128;

/**
 * Conversa de um contato com o assistente de um cliente. `contactRef` é o identificador do
 * contato definido pelo canal (texto livre); há uma conversa por (cliente, contactRef).
 */
export interface Conversation {
  readonly id: string;
  readonly clientId: ClientId;
  readonly contactRef: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Dados de criação. Não há `clientId` aqui: ele vem sempre do parâmetro do repositório. */
export interface NewConversation extends WithoutClientId {
  readonly contactRef: string;
}

/** Dados de atualização (ainda sem campos editáveis). */
export type ConversationUpdate = Readonly<Record<string, never>>;
