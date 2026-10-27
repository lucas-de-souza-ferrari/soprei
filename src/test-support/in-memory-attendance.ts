import { AsyncLocalStorage } from 'node:async_hooks';
import { setImmediate as nextTick } from 'node:timers/promises';
import {
  type AttendanceTransaction,
  type AttendanceUnitOfWork,
  type ClientId,
  type Conversation,
  type ConversationRepository,
  DEFAULT_LIST_LIMIT,
  type ListOptions,
  MAX_LIST_LIMIT,
  type Message,
  type MessageRepository,
  type NewConversation,
  type NewMessage,
  type Page,
} from '../domain/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../shared/errors/index.js';

/**
 * Repositórios de conversa e de mensagem em memória, mais a "transação", para os testes de
 * service e de rota que não precisam de banco. Mesmas regras do banco: tudo é filtrado pelo
 * `ClientId`, `(cliente, contactRef)`, `(cliente, externalId)` e `(cliente, replyToId)` são
 * únicos (`ConflictError`) e uma mensagem só aponta para conversa do mesmo cliente.
 *
 * Cada método cede o controle uma vez (`nextTick`), para que pedidos simultâneos se
 * intercalem de verdade, como ao esperar o banco.
 */
export class InMemoryAttendanceStore implements AttendanceUnitOfWork {
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;

  private readonly conversationRows: Conversation[] = [];
  private readonly messageRows: Message[] = [];
  private sequence = 0;
  /** Transações abertas agora (para provar que a chamada ao LLM fica fora delas). */
  openTransactions = 0;
  /** O que a transação em curso gravou, para desfazer só isso no rollback. */
  private readonly transactionLog = new AsyncLocalStorage<{
    conversations: Conversation[];
    messages: Message[];
  }>();

  constructor(private readonly now: () => Date = () => new Date()) {
    this.conversations = {
      findById: (clientId, id) => this.step(() => this.findConversation(clientId, id)),
      list: (clientId, options) =>
        this.step(() =>
          page(
            this.conversationRows.filter((row) => row.clientId === clientId),
            options,
          ),
        ),
      create: (clientId, data) => this.step(() => this.addConversation(clientId, data)),
      update: (clientId, id) => this.step(() => this.findConversation(clientId, id)),
      delete: (clientId, id) =>
        this.step(() => {
          const row = this.findConversation(clientId, id);
          this.conversationRows.splice(this.conversationRows.indexOf(row), 1);
        }),
      count: (clientId) =>
        this.step(() => this.conversationRows.filter((row) => row.clientId === clientId).length),
      findOrCreateByContact: (clientId, contactRef) =>
        this.step(
          () =>
            this.conversationRows.find(
              (row) => row.clientId === clientId && row.contactRef === contactRef,
            ) ?? this.addConversation(clientId, { contactRef }),
        ),
    } satisfies ConversationRepository;

    this.messages = {
      create: (clientId, data) => this.step(() => this.addMessage(clientId, data)),
      findByExternalId: (clientId, externalId) =>
        this.step(
          () =>
            this.messageRows.find(
              (row) => row.clientId === clientId && row.externalId === externalId,
            ) ?? null,
        ),
      findReplyTo: (clientId, messageId) =>
        this.step(
          () =>
            this.messageRows.find(
              (row) =>
                row.clientId === clientId &&
                row.replyToId === messageId &&
                row.role === 'ASSISTANT',
            ) ?? null,
        ),
      listRecent: (clientId, conversationId, limit) =>
        this.step(() => this.inConversation(clientId, conversationId).slice(-limit)),
      listByConversation: (clientId, conversationId, options) =>
        this.step(() => page(this.inConversation(clientId, conversationId), options)),
    } satisfies MessageRepository;
  }

  /** Todas as mensagens guardadas (qualquer cliente), para os testes conferirem o que foi gravado. */
  allMessages(): readonly Message[] {
    return [...this.messageRows];
  }

  allConversations(): readonly Conversation[] {
    return [...this.conversationRows];
  }

  async run<T>(fn: (tx: AttendanceTransaction) => Promise<T>): Promise<T> {
    const log = { conversations: [] as Conversation[], messages: [] as Message[] };
    this.openTransactions += 1;
    try {
      return await this.transactionLog.run(log, () =>
        fn({ conversations: this.conversations, messages: this.messages }),
      );
    } catch (error) {
      // Rollback: desfaz só o que ESTA transação gravou (outras podem estar em curso).
      for (const row of log.messages) this.messageRows.splice(this.messageRows.indexOf(row), 1);
      for (const row of log.conversations) {
        this.conversationRows.splice(this.conversationRows.indexOf(row), 1);
      }
      throw error;
    } finally {
      this.openTransactions -= 1;
    }
  }

  private async step<T>(fn: () => T): Promise<T> {
    await nextTick();
    return fn();
  }

  private nextId(): string {
    this.sequence += 1;
    return `00000000-0000-7000-8000-${this.sequence.toString(16).padStart(12, '0')}`;
  }

  private findConversation(clientId: ClientId, id: string): Conversation {
    const row = this.conversationRows.find(
      (candidate) => candidate.clientId === clientId && candidate.id === id,
    );
    if (row === undefined) throw new NotFoundError('Recurso não encontrado');
    return row;
  }

  private addConversation(clientId: ClientId, data: NewConversation): Conversation {
    if (
      this.conversationRows.some(
        (row) => row.clientId === clientId && row.contactRef === data.contactRef,
      )
    ) {
      throw new ConflictError('Já existe um registro com estes dados');
    }
    const now = this.now();
    const row: Conversation = {
      id: this.nextId(),
      clientId,
      contactRef: data.contactRef,
      createdAt: now,
      updatedAt: now,
    };
    this.conversationRows.push(row);
    this.transactionLog.getStore()?.conversations.push(row);
    return row;
  }

  private addMessage(clientId: ClientId, data: NewMessage): Message {
    // O que a chave estrangeira composta garante no banco.
    this.findConversation(clientId, data.conversationId);
    if (
      data.replyToId !== undefined &&
      !this.messageRows.some((row) => row.clientId === clientId && row.id === data.replyToId)
    ) {
      throw new NotFoundError('Mensagem respondida não encontrada');
    }
    if (
      data.externalId !== undefined &&
      this.messageRows.some(
        (row) => row.clientId === clientId && row.externalId === data.externalId,
      )
    ) {
      throw new ConflictError('Já existe um registro com estes dados');
    }
    if (
      data.replyToId !== undefined &&
      this.messageRows.some((row) => row.clientId === clientId && row.replyToId === data.replyToId)
    ) {
      throw new ConflictError('Já existe um registro com estes dados');
    }
    const row: Message = {
      id: this.nextId(),
      clientId,
      conversationId: data.conversationId,
      role: data.role,
      content: data.content,
      isFallback: data.isFallback ?? false,
      externalId: data.externalId ?? null,
      replyToId: data.replyToId ?? null,
      createdAt: data.createdAt ?? this.now(),
    };
    this.messageRows.push(row);
    this.transactionLog.getStore()?.messages.push(row);
    return row;
  }

  private inConversation(clientId: ClientId, conversationId: string): Message[] {
    return this.messageRows
      .filter((row) => row.clientId === clientId && row.conversationId === conversationId)
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      );
  }
}

/** Paginação por posição (o cursor é só o índice); `rows` já está na ordem certa. */
function page<T>(rows: readonly T[], options: ListOptions = {}): Page<T> {
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new ValidationError('limit inválido');
  }
  const start = options.cursor === undefined ? 0 : Number(options.cursor);
  if (!Number.isInteger(start) || start < 0) throw new ValidationError('Cursor inválido');
  const next = start + limit;
  return { items: rows.slice(start, next), nextCursor: next < rows.length ? String(next) : null };
}
