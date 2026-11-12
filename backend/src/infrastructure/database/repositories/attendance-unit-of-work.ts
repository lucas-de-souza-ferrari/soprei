import type { AttendanceTransaction, AttendanceUnitOfWork } from '../../../domain/index.js';
import { PrismaConversationRepository } from './conversation.repository.js';
import { PrismaMessageRepository } from './message.repository.js';
import { PrismaNotificationRepository } from './notification.repository.js';
import { runInTransaction, type TransactionOptions } from '../transaction.js';
import type { TenantScopedPrisma } from '../extensions/tenant-scope.js';

/**
 * Transação do atendimento: os repositórios de conversa e de mensagem sobre o mesmo company
 * transacional (`forTransaction`), com as mesmas barreiras de isolamento. O callback não deve
 * fazer chamada externa (a transação segura uma conexão do pool).
 */
export class PrismaAttendanceUnitOfWork implements AttendanceUnitOfWork {
  private readonly conversations: PrismaConversationRepository;
  private readonly messages: PrismaMessageRepository;
  private readonly notifications: PrismaNotificationRepository;

  constructor(
    private readonly prisma: TenantScopedPrisma,
    private readonly options: TransactionOptions = {},
  ) {
    this.conversations = new PrismaConversationRepository(prisma);
    this.messages = new PrismaMessageRepository(prisma);
    this.notifications = new PrismaNotificationRepository(prisma);
  }

  run<T>(fn: (tx: AttendanceTransaction) => Promise<T>): Promise<T> {
    return runInTransaction(
      this.prisma,
      (db) =>
        fn({
          conversations: this.conversations.forTransaction(db),
          messages: this.messages.forTransaction(db),
          notifications: this.notifications.forTransaction(db),
        }),
      this.options,
    );
  }
}
