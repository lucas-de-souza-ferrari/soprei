import type {
  PlatformCompanyTransaction,
  PlatformCompanyUnitOfWork,
} from '../../../application/ports/platform-company-unit-of-work.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import type { TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { runInTransaction, type TransactionOptions } from '../transaction.js';
import { lockCompanyRow } from './membership-admin-unit-of-work.js';
import { PrismaPlatformAuditRepository } from './platform-audit.repository.js';

/**
 * Suspender e reativar empresa pelo admin da plataforma (spec 044, E2): trava, estado e trilha na mesma
 * transação. Sem SQL cru novo: a trava é a da gestão de usuários (`lockCompanyRow`, spec 008) e o resto é
 * `findFirst`/`updateMany` em `companies` (global) e o `create` da trilha (global).
 */
export class PrismaPlatformCompanyUnitOfWork implements PlatformCompanyUnitOfWork {
  constructor(
    private readonly prisma: TenantScopedPrisma,
    private readonly options: TransactionOptions = {},
  ) {}

  run<T>(fn: (tx: PlatformCompanyTransaction) => Promise<T>): Promise<T> {
    return runInTransaction(
      this.prisma,
      (db) => {
        const audit = new PrismaPlatformAuditRepository(db);
        return fn({
          lockCompany: async (companyId) => {
            await lockCompanyRow(db, companyId);
            const row = await db.company.findFirst({
              where: { id: companyId, deletedAt: null },
              select: { status: true },
            });
            if (row === null) {
              throw new NotFoundError('Empresa não encontrada', { context: { entity: 'Company' } });
            }
            return row.status;
          },
          setStatus: async (companyId, status) => {
            await db.company.updateMany({
              where: { id: companyId, deletedAt: null },
              data: { status },
            });
          },
          audit: async (event) => {
            await audit.create(event);
          },
        });
      },
      this.options,
    );
  }
}
