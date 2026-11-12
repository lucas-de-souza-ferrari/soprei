import { randomUUID } from 'node:crypto';
import { setImmediate as nextTick } from 'node:timers/promises';
import {
  type CompanyId,
  DEFAULT_LIST_LIMIT,
  type ListOptions,
  type NewHandoffNotification,
  type Notification,
  type NotificationCreateResult,
  type NotificationRepository,
  type NotificationResolveResult,
  type NotificationStatusFilter,
  type OpenHandoff,
  type Page,
} from '../domain/index.js';
import { NotFoundError, ValidationError } from '../shared/errors/index.js';
import { isUuid } from '../shared/utils/index.js';

/**
 * Notificações em memória (spec 038), com as regras do banco: tudo filtrado pelo `CompanyId`, uma
 * aberta por conversa e tipo, id de outra empresa = inexistente. `onCreate` avisa a "transação" do
 * `InMemoryAttendanceStore`, que remove a linha no rollback.
 */
export class InMemoryNotificationRepository implements NotificationRepository {
  private readonly rows: Notification[] = [];

  constructor(private readonly onCreate: (id: string) => void = () => undefined) {}

  all(): readonly Notification[] {
    return [...this.rows];
  }

  /** Remove uma linha (rollback da transação em memória). */
  remove(id: string): void {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index !== -1) this.rows.splice(index, 1);
  }

  async createHandoff(
    companyId: CompanyId,
    data: NewHandoffNotification,
    maxOpen: number,
  ): Promise<NotificationCreateResult> {
    await nextTick();
    const open = this.rows.filter((row) => row.companyId === companyId && row.status === 'OPEN');
    if (open.some((row) => row.conversationId === data.conversationId)) return 'deduplicated';
    if (open.length >= maxOpen) return 'capped';
    const row: Notification = {
      id: randomUUID(),
      companyId,
      kind: 'HUMAN_HANDOFF',
      reason: data.reason,
      conversationId: data.conversationId,
      messageId: data.messageId,
      status: 'OPEN',
      createdAt: data.createdAt,
      resolvedAt: null,
      resolvedByMembershipId: null,
    };
    this.rows.push(row);
    this.onCreate(row.id);
    return 'created';
  }

  async list(
    companyId: CompanyId,
    status: NotificationStatusFilter,
    options?: ListOptions,
  ): Promise<Page<Notification>> {
    await nextTick();
    const limit = options?.limit ?? DEFAULT_LIST_LIMIT;
    const filtered = this.rows
      .filter(
        (row) =>
          row.companyId === companyId &&
          (status === 'all' || row.status === (status === 'open' ? 'OPEN' : 'RESOLVED')),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    let start = 0;
    if (options?.cursor !== undefined) {
      const index = filtered.findIndex((row) => row.id === options.cursor);
      if (index === -1) throw new ValidationError('Cursor inválido');
      start = index + 1;
    }
    const items = filtered.slice(start, start + limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: start + limit < filtered.length && last !== undefined ? last.id : null,
    };
  }

  async countOpen(companyId: CompanyId): Promise<number> {
    await nextTick();
    return this.rows.filter((row) => row.companyId === companyId && row.status === 'OPEN').length;
  }

  async resolve(
    companyId: CompanyId,
    id: string,
    membershipId: string,
    now: Date,
  ): Promise<NotificationResolveResult> {
    await nextTick();
    const index = this.rows.findIndex((row) => row.id === id && row.companyId === companyId);
    const row = this.rows[index];
    if (!isUuid(id) || row === undefined) {
      throw new NotFoundError('Recurso não encontrado', { context: { entity: 'Notification' } });
    }
    if (row.status === 'RESOLVED') return 'already';
    this.rows[index] = {
      ...row,
      status: 'RESOLVED',
      resolvedAt: now,
      resolvedByMembershipId: membershipId,
    };
    return 'resolved';
  }

  async openHandoffsByConversation(
    companyId: CompanyId,
    conversationIds: readonly string[],
  ): Promise<ReadonlyMap<string, OpenHandoff>> {
    await nextTick();
    const result = new Map<string, OpenHandoff>();
    for (const row of this.rows) {
      if (
        row.companyId === companyId &&
        row.status === 'OPEN' &&
        conversationIds.includes(row.conversationId)
      ) {
        result.set(row.conversationId, {
          notificationId: row.id,
          reason: row.reason,
          createdAt: row.createdAt,
        });
      }
    }
    return result;
  }
}
