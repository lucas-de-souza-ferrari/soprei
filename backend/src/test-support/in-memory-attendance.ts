import { AsyncLocalStorage } from 'node:async_hooks';
import { setImmediate as nextTick } from 'node:timers/promises';
import {
  type AttendanceTransaction,
  type AttendanceUnitOfWork,
  type CompanyId,
  type Conversation,
  type ConversationRepository,
  DEFAULT_LIST_LIMIT,
  type ListOptions,
  MAX_LIST_LIMIT,
  type Message,
  type MessageRepository,
  type MessageSentMark,
  type NewConversation,
  type NewMessage,
  type Page,
} from '../domain/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../shared/errors/index.js';

/**
 * Repositórios de conversa e de mensagem em memória, mais a "transação", para os testes de
 * service e de rota que não precisam de banco. Mesmas regras do banco: tudo é filtrado pelo
 * `CompanyId`, `(empresa, contactRef)`, `(empresa, externalId)` e `(empresa, replyToId)` são
 * únicos (`ConflictError`) e uma mensagem só aponta para conversa do mesma empresa.
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
    /** Ids de mensagens marcadas como atendidas (`markAnswered`) dentro da transação. */
    answered: string[];
  }>();

  constructor(private readonly now: () => Date = () => new Date()) {
    this.conversations = {
      findById: (companyId, id) => this.step(() => this.findConversation(companyId, id)),
      list: (companyId, options) =>
        this.step(() =>
          page(
            this.conversationRows.filter((row) => row.companyId === companyId),
            options,
          ),
        ),
      create: (companyId, data) => this.step(() => this.addConversation(companyId, data)),
      update: (companyId, id) => this.step(() => this.findConversation(companyId, id)),
      delete: (companyId, id) =>
        this.step(() => {
          const row = this.findConversation(companyId, id);
          this.conversationRows.splice(this.conversationRows.indexOf(row), 1);
        }),
      count: (companyId) =>
        this.step(() => this.conversationRows.filter((row) => row.companyId === companyId).length),
      findByContact: (companyId, contactRef) =>
        this.step(
          () =>
            this.conversationRows.find(
              (row) => row.companyId === companyId && row.contactRef === contactRef,
            ) ?? null,
        ),
      findOrCreateByContact: (companyId, contactRef) =>
        this.step(
          () =>
            this.conversationRows.find(
              (row) => row.companyId === companyId && row.contactRef === contactRef,
            ) ?? this.addConversation(companyId, { contactRef }),
        ),
    } satisfies ConversationRepository;

    this.messages = {
      create: (companyId, data) => this.step(() => this.addMessage(companyId, data)),
      findByExternalId: (companyId, externalId) =>
        this.step(
          () =>
            this.messageRows.find(
              (row) => row.companyId === companyId && row.externalId === externalId,
            ) ?? null,
        ),
      findReplyTo: (companyId, messageId) =>
        this.step(
          () =>
            this.messageRows.find(
              (row) =>
                row.companyId === companyId &&
                row.replyToId === messageId &&
                row.role === 'ASSISTANT',
            ) ?? null,
        ),
      listRecent: (companyId, conversationId, limit) =>
        this.step(() => this.inConversation(companyId, conversationId).slice(-limit)),
      listBefore: (companyId, conversationId, messageId, limit) =>
        this.step(() => {
          const ordered = this.inConversation(companyId, conversationId);
          const index = ordered.findIndex((row) => row.id === messageId);
          return index === -1 ? [] : ordered.slice(Math.max(0, index - limit), index);
        }),
      markSent: (companyId, messageId, mark) =>
        this.step(() => this.applyMark(companyId, messageId, mark)),
      listPending: (companyId, conversationId, limit) =>
        this.step(() => this.pendingIn(companyId, conversationId).slice(0, limit)),
      markAnswered: (companyId, messageIds, replyId) =>
        this.step(() => this.applyAnswered(companyId, messageIds, replyId)),
      listByConversation: (companyId, conversationId, options) =>
        this.step(() => page(this.inConversation(companyId, conversationId), options)),
    } satisfies MessageRepository;
  }

  /** Todas as mensagens guardadas (qualquer empresa), para os testes conferirem o que foi gravado. */
  allMessages(): readonly Message[] {
    return [...this.messageRows];
  }

  allConversations(): readonly Conversation[] {
    return [...this.conversationRows];
  }

  async run<T>(fn: (tx: AttendanceTransaction) => Promise<T>): Promise<T> {
    const log = {
      conversations: [] as Conversation[],
      messages: [] as Message[],
      answered: [] as string[],
    };
    this.openTransactions += 1;
    try {
      return await this.transactionLog.run(log, () =>
        fn({ conversations: this.conversations, messages: this.messages }),
      );
    } catch (error) {
      // Rollback: desfaz só o que ESTA transação gravou (outras podem estar em curso).
      for (const id of log.answered) {
        const index = this.messageRows.findIndex((row) => row.id === id);
        const row = this.messageRows[index];
        if (row !== undefined) this.messageRows[index] = { ...row, answeredById: null };
      }
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

  private findConversation(companyId: CompanyId, id: string): Conversation {
    const row = this.conversationRows.find(
      (candidate) => candidate.companyId === companyId && candidate.id === id,
    );
    if (row === undefined) throw new NotFoundError('Recurso não encontrado');
    return row;
  }

  private addConversation(companyId: CompanyId, data: NewConversation): Conversation {
    if (
      this.conversationRows.some(
        (row) => row.companyId === companyId && row.contactRef === data.contactRef,
      )
    ) {
      throw new ConflictError('Já existe um registro com estes dados');
    }
    const now = this.now();
    const row: Conversation = {
      id: this.nextId(),
      companyId,
      contactRef: data.contactRef,
      createdAt: now,
      updatedAt: now,
    };
    this.conversationRows.push(row);
    this.transactionLog.getStore()?.conversations.push(row);
    return row;
  }

  private addMessage(companyId: CompanyId, data: NewMessage): Message {
    // O que a chave estrangeira composta garante no banco.
    this.findConversation(companyId, data.conversationId);
    if (
      data.replyToId !== undefined &&
      !this.messageRows.some((row) => row.companyId === companyId && row.id === data.replyToId)
    ) {
      throw new NotFoundError('Mensagem respondida não encontrada');
    }
    if (
      data.externalId !== undefined &&
      this.messageRows.some(
        (row) => row.companyId === companyId && row.externalId === data.externalId,
      )
    ) {
      throw new ConflictError('Já existe um registro com estes dados');
    }
    if (
      data.replyToId !== undefined &&
      this.messageRows.some(
        (row) => row.companyId === companyId && row.replyToId === data.replyToId,
      )
    ) {
      throw new ConflictError('Já existe um registro com estes dados');
    }
    const row: Message = {
      id: this.nextId(),
      companyId,
      conversationId: data.conversationId,
      role: data.role,
      content: data.content,
      isFallback: data.isFallback ?? false,
      externalId: data.externalId ?? null,
      replyToId: data.replyToId ?? null,
      createdAt: data.createdAt ?? this.now(),
      channelMessageId: null,
      sentAt: null,
      answeredById: null,
    };
    this.messageRows.push(row);
    this.transactionLog.getStore()?.messages.push(row);
    return row;
  }

  /** Como o `markSent` do banco: só ASSISTANT desta empresa e ainda sem marca. */
  private applyMark(companyId: CompanyId, messageId: string, mark: MessageSentMark): boolean {
    const index = this.messageRows.findIndex(
      (row) =>
        row.companyId === companyId &&
        row.id === messageId &&
        row.role === 'ASSISTANT' &&
        row.sentAt === null,
    );
    const row = this.messageRows[index];
    if (row === undefined) return false;
    this.messageRows[index] = {
      ...row,
      channelMessageId: mark.channelMessageId,
      sentAt: mark.sentAt,
    };
    return true;
  }

  /** Como o `listPending` do banco: USER, sem `answeredById` e sem resposta por `replyToId`. */
  private pendingIn(companyId: CompanyId, conversationId: string): Message[] {
    return this.inConversation(companyId, conversationId).filter(
      (row) =>
        row.role === 'USER' &&
        row.answeredById === null &&
        !this.messageRows.some(
          (other) => other.companyId === companyId && other.replyToId === row.id,
        ),
    );
  }

  /** Como o `markAnswered` do banco: só USER desta empresa, ainda sem marca; a resposta é do mesma empresa. */
  private applyAnswered(
    companyId: CompanyId,
    messageIds: readonly string[],
    replyId: string,
  ): number {
    if (!this.messageRows.some((row) => row.companyId === companyId && row.id === replyId)) {
      throw new NotFoundError('Mensagem de resposta não encontrada');
    }
    let marked = 0;
    for (const id of messageIds) {
      const index = this.messageRows.findIndex(
        (row) =>
          row.companyId === companyId &&
          row.id === id &&
          row.role === 'USER' &&
          row.answeredById === null,
      );
      const row = this.messageRows[index];
      if (row === undefined) continue;
      this.messageRows[index] = { ...row, answeredById: replyId };
      this.transactionLog.getStore()?.answered.push(id);
      marked += 1;
    }
    return marked;
  }

  private inConversation(companyId: CompanyId, conversationId: string): Message[] {
    return this.messageRows
      .filter((row) => row.companyId === companyId && row.conversationId === conversationId)
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
