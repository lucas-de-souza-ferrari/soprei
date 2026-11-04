import type { AuditEvent, NewAuditEvent } from '../entities/audit-event.js';
import type { ListOptions, Page } from '../pagination.js';
import type { CompanyId } from '../value-objects/company-id.js';

/**
 * Trilha de auditoria de uma empresa (spec 008). `CompanyId` é o primeiro parâmetro de todo método.
 * Só `create` e `list`: **sem `update` nem `delete`**, a trilha é imutável pela API.
 */
export interface AuditRepository {
  create(companyId: CompanyId, data: NewAuditEvent): Promise<AuditEvent>;
  /** Mais recentes primeiro (`createdAt` e `id` decrescentes), paginado por cursor. */
  list(companyId: CompanyId, options?: ListOptions): Promise<Page<AuditEvent>>;
}
