import {
  AccountId,
  CompanyId,
  type ListOptions,
  type NewPlatformAuditEvent,
  type Page,
  PlatformAdminId,
  type PlatformAuditEvent,
  type PlatformAuditRepository,
} from '../../../domain/index.js';
import type { PlatformAuditEvent as PlatformAuditEventRow } from '../../../generated/prisma/client.js';
import type { TenantScopedDb } from '../extensions/tenant-scope.js';
import { buildDescPageQuery, descOrderBy, toPage } from './cursor.js';
import { withRepositoryErrors } from './repository-errors.js';

function toPlatformAuditEvent(row: PlatformAuditEventRow): PlatformAuditEvent {
  return {
    id: row.id,
    adminId: PlatformAdminId.parse(row.adminId),
    action: row.action,
    subjectCompanyId: row.subjectCompanyId === null ? null : CompanyId.parse(row.subjectCompanyId),
    subjectAccountId: row.subjectAccountId === null ? null : AccountId.parse(row.subjectAccountId),
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

/**
 * Trilha da plataforma (spec 044, model global). Só `create` e `list`: imutável pela API (não há
 * `update` nem `delete` aqui, de propósito). Sem texto livre, e-mail nem IP.
 */
export class PrismaPlatformAuditRepository implements PlatformAuditRepository {
  constructor(private readonly db: TenantScopedDb) {}

  create(data: NewPlatformAuditEvent): Promise<PlatformAuditEvent> {
    return withRepositoryErrors('PlatformAuditEvent.create', async () => {
      const row = await this.db.platformAuditEvent.create({
        data: {
          adminId: data.adminId,
          action: data.action,
          subjectCompanyId: data.subjectCompanyId ?? null,
          subjectAccountId: data.subjectAccountId ?? null,
          reason: data.reason ?? null,
        },
      });
      return toPlatformAuditEvent(row);
    });
  }

  list(options?: ListOptions): Promise<Page<PlatformAuditEvent>> {
    return withRepositoryErrors('PlatformAuditEvent.list', async () => {
      const { limit, take, after } = buildDescPageQuery(options);
      const rows = await this.db.platformAuditEvent.findMany({
        where: after === undefined ? {} : { OR: after },
        orderBy: descOrderBy(),
        take,
      });
      return toPage(rows, limit, toPlatformAuditEvent);
    });
  }
}
