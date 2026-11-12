import type { Message, MessageSentMark, NewMessage } from '../entities/message.js';
import type { ListOptions, Page } from '../pagination.js';
import type { CompanyId } from '../value-objects/company-id.js';

/**
 * Repositório de `Message`. O `CompanyId` é o primeiro parâmetro de todo método; mensagem ou
 * conversa de outra empresa se comporta como inexistente.
 */
export type MessageOrder = 'asc' | 'desc';

export interface MessageRepository {
  /**
   * Grava a mensagem. Lança `ConflictError` se o `externalId` já existe nesta empresa ou se a
   * mensagem do contato (`replyToId`) já tem resposta. A conversa e a mensagem referenciadas
   * precisam ser do mesma empresa (o banco garante com chave estrangeira composta). Na mesma
   * transação, leva a última atividade da conversa (`updatedAt`) até o `createdAt` da mensagem
   * (nunca para trás; spec 024).
   */
  create(companyId: CompanyId, data: NewMessage): Promise<Message>;
  /** A mensagem desta empresa com esse id de canal, ou `null`. */
  findByExternalId(companyId: CompanyId, externalId: string): Promise<Message | null>;
  /** A resposta do assistente à mensagem do contato `messageId`, ou `null` se ainda não há. */
  findReplyTo(companyId: CompanyId, messageId: string): Promise<Message | null>;
  /** As `limit` mensagens mais recentes da conversa, em ordem cronológica (mais antiga primeiro). */
  listRecent(
    companyId: CompanyId,
    conversationId: string,
    limit: number,
  ): Promise<readonly Message[]>;
  /**
   * As até `limit` mensagens da conversa **anteriores** a `messageId` (na ordem `createdAt`, `id`),
   * em ordem cronológica. Vazio se a mensagem não existe nesta conversa desta empresa.
   */
  listBefore(
    companyId: CompanyId,
    conversationId: string,
    messageId: string,
    limit: number,
  ): Promise<readonly Message[]>;
  /**
   * Marca a resposta do assistente como enviada ao canal. Só altera mensagem desta empresa, do
   * papel `ASSISTANT` e ainda sem marca (idempotente). Devolve `true` se marcou, `false` se não
   * havia o que marcar (inexistente, de outra empresa, do contato ou já marcada).
   */
  markSent(companyId: CompanyId, messageId: string, mark: MessageSentMark): Promise<boolean>;
  /**
   * As até `limit` mensagens do **contato** da conversa que ainda esperam resposta, as mais antigas
   * primeiro (spec 013). Pendente = papel `USER`, sem `answeredById` e sem resposta por `replyToId`
   * (esta segunda condição cobre o simulador e as linhas anteriores ao agrupamento). Spec 039: também
   * só as com `createdAt` **depois** do `aiIgnoreBefore` da conversa (o que a equipe já tratou pelo
   * celular nunca volta a ser respondido pela IA).
   */
  listPending(
    companyId: CompanyId,
    conversationId: string,
    limit: number,
  ): Promise<readonly Message[]>;
  /**
   * A resposta nossa (`ASSISTANT`) desta empresa enviada ao canal com este id (`channelMessageId`),
   * ou `null`. Spec 039: reconhece o eco de uma mensagem que o próprio Soprei enviou (defesa).
   */
  findByChannelMessageId(companyId: CompanyId, channelMessageId: string): Promise<Message | null>;
  /**
   * Marca as mensagens do contato `messageIds` como atendidas pela resposta `replyId`. Só altera
   * mensagem desta empresa, do papel `USER` e ainda sem `answeredById` (idempotente: repetir não
   * muda nada; id de outra empresa é ignorado). Devolve quantas mensagens marcou.
   */
  markAnswered(
    companyId: CompanyId,
    messageIds: readonly string[],
    replyId: string,
  ): Promise<number>;
  /**
   * Histórico paginado da conversa: `asc` (padrão) em ordem cronológica, `desc` da mais nova para a
   * mais antiga (spec 024; o cursor sempre olha adiante na ordem pedida).
   */
  listByConversation(
    companyId: CompanyId,
    conversationId: string,
    options?: ListOptions,
    order?: MessageOrder,
  ): Promise<Page<Message>>;
}
