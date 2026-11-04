import type { AuditAction, AuditEvent, NewAuditEvent } from '../entities/audit-event.js';
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
  /**
   * Quantos eventos das `actions` ocorreram desde `since` (inclusive), opcionalmente de um só ator.
   * Leitura de contagem: as cotas de envio de convite (spec 025) contam `INVITATION_CREATED` e
   * `INVITATION_RESENT`. Não altera a trilha.
   */
  countSince(
    companyId: CompanyId,
    filter: {
      readonly actions: readonly AuditAction[];
      readonly since: Date;
      readonly actorMembershipId?: string;
    },
  ): Promise<number>;
}
