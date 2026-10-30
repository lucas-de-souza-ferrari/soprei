import type {
  AuditEvent,
  AuditRepository,
  ClientId,
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
 * API (não há `update` nem `delete` aqui, de propósito). O filtro por cliente é montado neste
 * repositório (`clientId` em todo `where` e em todo `create`) e a `tenant-scope` recusa qualquer
 * consulta sem ele. As chaves estrangeiras compostas do banco impedem apontar para usuário de
 * outro cliente.
 */
export class PrismaAuditRepository implements AuditRepository {
  constructor(private readonly db: TenantScopedDb) {}

  forTransaction(tx: TenantScopedDb): PrismaAuditRepository {
    return new PrismaAuditRepository(tx);
  }

  create(clientId: ClientId, data: NewAuditEvent): Promise<AuditEvent> {
    return withRepositoryErrors('AuditEvent.create', async () => {
      const row = await this.db.auditEvent.create({
        data: {
          clientId,
          action: data.action,
          actorUserId: data.actorUserId,
          targetUserId: data.targetUserId,
          fromRole: data.fromRole ?? null,
          toRole: data.toRole ?? null,
        },
      });
      return toAuditEvent(row);
    });
  }

  list(clientId: ClientId, options?: ListOptions): Promise<Page<AuditEvent>> {
    return withRepositoryErrors('AuditEvent.list', async () => {
      const { limit, take, after } = buildDescPageQuery(options);
      const rows = await this.db.auditEvent.findMany({
        where: { clientId, ...(after === undefined ? {} : { OR: after }) },
        orderBy: descOrderBy(),
        take,
      });
      return toPage(rows, limit, toAuditEvent);
    });
  }
}
