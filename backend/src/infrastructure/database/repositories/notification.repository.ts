import {
  CompanyId,
  type ListOptions,
  type NewHandoffNotification,
  type Notification,
  type NotificationCreateResult,
  type NotificationRepository,
  type NotificationResolveResult,
  type NotificationStatusFilter,
  type OpenHandoff,
  type Page,
} from '../../../domain/index.js';
import type { Notification as NotificationRow } from '../../../generated/prisma/client.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import { isUuid } from '../../../shared/utils/index.js';
import type { TenantScopedDb } from '../extensions/tenant-scope.js';
import { buildDescPageQuery, descOrderBy, toPage } from './cursor.js';
import { withRepositoryErrors } from './repository-errors.js';

function notFound(): NotFoundError {
  return new NotFoundError('Recurso não encontrado', { context: { entity: 'Notification' } });
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    companyId: CompanyId.parse(row.companyId),
    kind: row.kind,
    reason: row.reason,
    conversationId: row.conversationId,
    messageId: row.messageId,
    status: row.status,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolvedByMembershipId: row.resolvedByMembershipId,
  };
}

const STATUS_WHERE = {
  open: { status: 'OPEN' },
  resolved: { status: 'RESOLVED' },
  all: {},
} as const satisfies Record<NotificationStatusFilter, object>;

/**
 * Notificações de uma empresa (spec 030, model de tenant). Mesmas garantias da base de tenant: `companyId`
 * em **todo** `where` e em todo `create`, só `findFirst`, `findMany`, `createMany`, `updateMany` e `count`
 * (a `tenant-scope` recusa o resto), e id de outra empresa se comporta como inexistente. Sem SQL cru.
 * Não há `delete`: a notificação só avança de `OPEN` para `RESOLVED`.
 */
export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly db: TenantScopedDb) {}

  forTransaction(tx: TenantScopedDb): PrismaNotificationRepository {
    return new PrismaNotificationRepository(tx);
  }

  createHandoff(
    companyId: CompanyId,
    data: NewHandoffNotification,
    maxOpen: number,
  ): Promise<NotificationCreateResult> {
    return this.run('createHandoff', async () => {
      const kind = 'HUMAN_HANDOFF' as const;
      // Teto por empresa: contagem antes do INSERT, então é APROXIMADO sob concorrência (pedidos
      // simultâneos em conversas diferentes podem passar juntos; o excesso é limitado ao paralelismo).
      const open = await this.db.notification.count({ where: { companyId, status: 'OPEN' } });
      if (open >= maxOpen) {
        const existing = await this.db.notification.count({
          where: { companyId, conversationId: data.conversationId, kind, status: 'OPEN' },
        });
        return existing > 0 ? 'deduplicated' : 'capped';
      }
      // Sem contagem prévia de duplicata: o índice único parcial decide sozinho. `skipDuplicates` vira
      // INSERT ... ON CONFLICT DO NOTHING, que espera um UPDATE concorrente (alguém resolvendo a aberta)
      // e insere se a linha antiga saiu do predicado: o pedido novo não se perde nessa corrida, e a
      // transação do atendimento não aborta.
      const { count } = await this.db.notification.createMany({
        data: [
          {
            companyId,
            kind,
            reason: data.reason,
            conversationId: data.conversationId,
            messageId: data.messageId,
            createdAt: data.createdAt,
          },
        ],
        skipDuplicates: true,
      });
      return count === 1 ? 'created' : 'deduplicated';
    });
  }

  list(
    companyId: CompanyId,
    status: NotificationStatusFilter,
    options?: ListOptions,
  ): Promise<Page<Notification>> {
    return this.run('list', async () => {
      const { limit, take, after } = buildDescPageQuery(options);
      const rows = await this.db.notification.findMany({
        where: {
          companyId,
          ...STATUS_WHERE[status],
          ...(after === undefined ? {} : { OR: after }),
        },
        orderBy: descOrderBy(),
        take,
      });
      return toPage(rows, limit, toNotification);
    });
  }

  countOpen(companyId: CompanyId): Promise<number> {
    return this.run('countOpen', () =>
      this.db.notification.count({ where: { companyId, status: 'OPEN' } }),
    );
  }

  resolve(
    companyId: CompanyId,
    id: string,
    membershipId: string,
    now: Date,
  ): Promise<NotificationResolveResult> {
    return this.run('resolve', async () => {
      // Id malformado nunca existe: não vai ao banco (o cast para uuid falharia com erro 500).
      if (!isUuid(id)) throw notFound();
      const { count } = await this.db.notification.updateMany({
        where: { id, companyId, status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt: now, resolvedByMembershipId: membershipId },
      });
      if (count === 1) return 'resolved';
      const row = await this.db.notification.findFirst({
        where: { id, companyId },
        select: { id: true },
      });
      if (row === null) throw notFound();
      return 'already';
    });
  }

  openHandoffsByConversation(
    companyId: CompanyId,
    conversationIds: readonly string[],
  ): Promise<ReadonlyMap<string, OpenHandoff>> {
    return this.run('openHandoffsByConversation', async () => {
      const ids = conversationIds.filter((id) => isUuid(id));
      const result = new Map<string, OpenHandoff>();
      if (ids.length === 0) return result;
      const rows = await this.db.notification.findMany({
        where: {
          companyId,
          kind: 'HUMAN_HANDOFF',
          status: 'OPEN',
          conversationId: { in: ids },
        },
        select: { id: true, conversationId: true, reason: true, createdAt: true },
      });
      for (const row of rows) {
        result.set(row.conversationId, {
          notificationId: row.id,
          reason: row.reason,
          createdAt: row.createdAt,
        });
      }
      return result;
    });
  }

  private run<R>(operation: string, fn: () => Promise<R>): Promise<R> {
    return withRepositoryErrors(`Notification.${operation}`, fn);
  }
}
