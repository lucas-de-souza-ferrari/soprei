import type {
  AuditEvent,
  AuditRepository,
  CompanyId,
  ListOptions,
  NewAuditEvent,
  Page,
} from '../../../domain/index.js';
import type { TenantScopedDb } from '../extensions/tenant-scope.js';
import { buildDescPageQuery, descOrderBy, toPage } from './cursor.js';
import { toAuditEvent } from './mappers.js';
import { withRepositoryErrors } from './repository-errors.js';

/**
 * Trilha de auditoria (spec 008, model de tenant). Só `create` e `list`: a trilha é imutável pela
 * API (não há `update` nem `delete` aqui, de propósito). O filtro por empresa é montado neste
 * repositório (`companyId` em todo `where` e em todo `create`) e a `tenant-scope` recusa qualquer
 * consulta sem ele. As chaves estrangeiras compostas do banco impedem apontar para usuário de
 * outra empresa.
 */
export class PrismaAuditRepository implements AuditRepository {
  constructor(private readonly db: TenantScopedDb) {}

  forTransaction(tx: TenantScopedDb): PrismaAuditRepository {
    return new PrismaAuditRepository(tx);
  }

  create(companyId: CompanyId, data: NewAuditEvent): Promise<AuditEvent> {
    return withRepositoryErrors('AuditEvent.create', async () => {
      const row = await this.db.auditEvent.create({
        data: {
          companyId,
          action: data.action,
          actorMembershipId: data.actorMembershipId,
          targetMembershipId: data.targetMembershipId ?? null,
          fromRole: data.fromRole ?? null,
          toRole: data.toRole ?? null,
        },
      });
      return toAuditEvent(row);
    });
  }

  list(companyId: CompanyId, options?: ListOptions): Promise<Page<AuditEvent>> {
    return withRepositoryErrors('AuditEvent.list', async () => {
      const { limit, take, after } = buildDescPageQuery(options);
      const rows = await this.db.auditEvent.findMany({
        where: { companyId, ...(after === undefined ? {} : { OR: after }) },
        orderBy: descOrderBy(),
        take,
      });
      return toPage(rows, limit, toAuditEvent);
    });
  }
}
