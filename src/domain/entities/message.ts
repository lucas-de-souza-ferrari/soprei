import type { WithoutClientId } from '../repositories/tenant.repository.js';
import type { ClientId } from '../value-objects/client-id.js';

export const MESSAGE_ROLES = ['USER', 'ASSISTANT'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** Limite de caracteres do texto de uma mensagem (do contato e do assistente). */
export const MESSAGE_CONTENT_MAX_LENGTH = 4000;
/** Limite de caracteres do `externalId` (id da mensagem no canal). */
export const EXTERNAL_ID_MAX_LENGTH = 128;

/**
 * Mensagem de uma conversa. O `content` é dado pessoal: nunca vai para log nem para label
 * de métrica (só id, tamanho e resultado).
 */
export interface Message {
  readonly id: string;
  readonly clientId: ClientId;
  readonly conversationId: string;
  readonly role: MessageRole;
  readonly content: string;
  /** Verdadeiro só em resposta do assistente que é o texto padrão de falha. */
  readonly isFallback: boolean;
  /** Id da mensagem no canal; único por cliente quando presente (idempotência). */
  readonly externalId: string | null;
  /** Na resposta do assistente, o id da mensagem do contato a que ela responde. */
  readonly replyToId: string | null;
  readonly createdAt: Date;
}

/** Dados de criação. Não há `clientId` aqui: ele vem sempre do parâmetro do repositório. */
export interface NewMessage extends WithoutClientId {
  readonly conversationId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly isFallback?: boolean;
  readonly externalId?: string;
  readonly replyToId?: string;
  /** Só para garantir a ordem causal (a resposta nunca fica antes da pergunta). Padrão: agora. */
  readonly createdAt?: Date;
}

/** Mensagens são imutáveis: não há campos editáveis. */
export type MessageUpdate = Readonly<Record<string, never>>;
