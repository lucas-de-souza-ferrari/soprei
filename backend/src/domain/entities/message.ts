import type { WithoutCompanyId } from '../repositories/tenant.repository.js';
import type { CompanyId } from '../value-objects/company-id.js';

/**
 * `USER`: o contato; `ASSISTANT`: a IA; `HUMAN`: a equipe, pelo aplicativo WhatsApp Business (eco da
 * coexistência, spec 039). `HUMAN` é o lado da empresa: vai ao modelo como turno do assistente.
 */
export const MESSAGE_ROLES = ['USER', 'ASSISTANT', 'HUMAN'] as const;
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
  readonly companyId: CompanyId;
  readonly conversationId: string;
  readonly role: MessageRole;
  readonly content: string;
  /** Verdadeiro só em resposta do assistente que é o texto padrão de falha. */
  readonly isFallback: boolean;
  /** Id da mensagem no canal; único por empresa quando presente (idempotência). */
  readonly externalId: string | null;
  /** Na resposta do assistente, o id da mensagem do contato a que ela responde. */
  readonly replyToId: string | null;
  readonly createdAt: Date;
  /** Id da mensagem enviada no canal; só em resposta do assistente já enviada. */
  readonly channelMessageId: string | null;
  /** Quando a resposta foi entregue ao canal; nulo = ainda não enviada. */
  readonly sentAt: Date | null;
  /**
   * Na mensagem do **contato**, o id da resposta do assistente que a atendeu (agrupamento de
   * mensagens, spec 013): várias mensagens do mesmo lote apontam para a mesma resposta. Nulo em
   * mensagem do assistente e em mensagem do contato ainda sem resposta (ou respondida só pelo
   * caminho de uma resposta por mensagem, via `replyToId`).
   */
  readonly answeredById: string | null;
  /**
   * Spec 035 (revisão, I4): a Meta aceitou o envio desta resposta (2xx) mas devolveu sem id legível.
   * Provavelmente entregue: nunca é reenviada. Opcional para os testes antigos (ausente = nulo).
   */
  readonly deliveryUncertainAt?: Date | null;
}

/** Marca de envio de uma resposta do assistente (`MessageRepository.markSent`). */
export interface MessageSentMark {
  readonly channelMessageId: string;
  readonly sentAt: Date;
}

/** Dados de criação. Não há `companyId` aqui: ele vem sempre do parâmetro do repositório. */
export interface NewMessage extends WithoutCompanyId {
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
