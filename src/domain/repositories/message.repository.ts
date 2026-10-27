import type { Message, MessageSentMark, NewMessage } from '../entities/message.js';
import type { ListOptions, Page } from '../pagination.js';
import type { ClientId } from '../value-objects/client-id.js';

/**
 * Repositório de `Message`. O `ClientId` é o primeiro parâmetro de todo método; mensagem ou
 * conversa de outro cliente se comporta como inexistente.
 */
export interface MessageRepository {
  /**
   * Grava a mensagem. Lança `ConflictError` se o `externalId` já existe neste cliente ou se a
   * mensagem do contato (`replyToId`) já tem resposta. A conversa e a mensagem referenciadas
   * precisam ser do mesmo cliente (o banco garante com chave estrangeira composta).
   */
  create(clientId: ClientId, data: NewMessage): Promise<Message>;
  /** A mensagem deste cliente com esse id de canal, ou `null`. */
  findByExternalId(clientId: ClientId, externalId: string): Promise<Message | null>;
  /** A resposta do assistente à mensagem do contato `messageId`, ou `null` se ainda não há. */
  findReplyTo(clientId: ClientId, messageId: string): Promise<Message | null>;
  /** As `limit` mensagens mais recentes da conversa, em ordem cronológica (mais antiga primeiro). */
  listRecent(
    clientId: ClientId,
    conversationId: string,
    limit: number,
  ): Promise<readonly Message[]>;
  /**
   * As até `limit` mensagens da conversa **anteriores** a `messageId` (na ordem `createdAt`, `id`),
   * em ordem cronológica. Vazio se a mensagem não existe nesta conversa deste cliente.
   */
  listBefore(
    clientId: ClientId,
    conversationId: string,
    messageId: string,
    limit: number,
  ): Promise<readonly Message[]>;
  /**
   * Marca a resposta do assistente como enviada ao canal. Só altera mensagem deste cliente, do
   * papel `ASSISTANT` e ainda sem marca (idempotente). Devolve `true` se marcou, `false` se não
   * havia o que marcar (inexistente, de outro cliente, do contato ou já marcada).
   */
  markSent(clientId: ClientId, messageId: string, mark: MessageSentMark): Promise<boolean>;
  /** Histórico paginado da conversa, em ordem cronológica. */
  listByConversation(
    clientId: ClientId,
    conversationId: string,
    options?: ListOptions,
  ): Promise<Page<Message>>;
}
