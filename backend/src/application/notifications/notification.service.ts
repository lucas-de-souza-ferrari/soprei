import type {
  CompanyId,
  ListOptions,
  Notification,
  NotificationKind,
  NotificationRepository,
  NotificationResolveResult,
  NotificationStatusFilter,
  OpenHandoff,
  Page,
} from '../../domain/index.js';

/** Métricas das notificações (spec 030): conjunto fixo de labels, nunca id nem texto. */
export interface NotificationMetrics {
  countNotificationResolved(kind: NotificationKind): void;
}

export interface NotificationLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface NotificationDeps {
  readonly notifications: NotificationRepository;
  readonly logger: NotificationLogger;
  readonly metrics?: NotificationMetrics;
  /** Relógio injetável, para os testes. */
  readonly now?: () => Date;
}

/**
 * Notificações do painel (spec 030). O `CompanyId` vem sempre da identidade autenticada; o
 * repositório o exige em toda consulta. O log leva só ids e o resultado.
 */
export class NotificationService {
  constructor(private readonly deps: NotificationDeps) {}

  list(
    companyId: CompanyId,
    status: NotificationStatusFilter,
    options?: ListOptions,
  ): Promise<Page<Notification>> {
    return this.deps.notifications.list(companyId, status, options);
  }

  countOpen(companyId: CompanyId): Promise<number> {
    return this.deps.notifications.countOpen(companyId);
  }

  async resolve(
    companyId: CompanyId,
    notificationId: string,
    membershipId: string,
  ): Promise<NotificationResolveResult> {
    const now = this.deps.now?.() ?? new Date();
    const result = await this.deps.notifications.resolve(
      companyId,
      notificationId,
      membershipId,
      now,
    );
    if (result === 'resolved') {
      try {
        this.deps.metrics?.countNotificationResolved('HUMAN_HANDOFF');
      } catch (err) {
        this.deps.logger.warn({ err }, 'falha ao registrar métrica de notificação');
      }
    }
    this.deps.logger.info(
      { companyId, notificationId, membershipId, result },
      'notificação marcada como resolvida',
    );
    return result;
  }

  openHandoffs(
    companyId: CompanyId,
    conversationIds: readonly string[],
  ): Promise<ReadonlyMap<string, OpenHandoff>> {
    return this.deps.notifications.openHandoffsByConversation(companyId, conversationIds);
  }
}
