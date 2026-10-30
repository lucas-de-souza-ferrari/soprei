import type { AuditEvent, NewAuditEvent } from '../entities/audit-event.js';
import type { ListOptions, Page } from '../pagination.js';
import type { ClientId } from '../value-objects/client-id.js';

/**
 * Trilha de auditoria de um cliente (spec 008). `ClientId` é o primeiro parâmetro de todo método.
 * Só `create` e `list`: **sem `update` nem `delete`**, a trilha é imutável pela API.
 */
export interface AuditRepository {
  create(clientId: ClientId, data: NewAuditEvent): Promise<AuditEvent>;
  /** Mais recentes primeiro (`createdAt` e `id` decrescentes), paginado por cursor. */
  list(clientId: ClientId, options?: ListOptions): Promise<Page<AuditEvent>>;
}
