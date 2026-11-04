import type {
  ChannelTransaction,
  ChannelUnitOfWork,
} from '../../../application/ports/channel-unit-of-work.js';
import type { CompanyId } from '../../../domain/index.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import type { TenantScopedDb, TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { runInTransaction, type TransactionOptions } from '../transaction.js';
import { PrismaAuditRepository } from './audit.repository.js';
import { PrismaChannelConnectionRepository } from './channel-connection.repository.js';
import { PrismaCompanyRepository } from './company.repository.js';

/**
 * Trava a linha da empresa até o fim da transação: mesmo SQL controlado da gestão de usuários
 * (`SELECT ... FOR NO KEY UPDATE` parametrizado, cast para uuid, tabela global `companies`).
 */
async function lockCompanyRow(db: TenantScopedDb, companyId: CompanyId): Promise<void> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM companies WHERE id = ${companyId}::uuid AND deleted_at IS NULL FOR NO KEY UPDATE`;
  if (rows.length === 0) {
    throw new NotFoundError('Empresa não encontrada', { context: { entity: 'Company' } });
  }
}

/** Transação do canal (spec 015): conexão, número da empresa e auditoria sobre o mesmo company. */
export class PrismaChannelUnitOfWork implements ChannelUnitOfWork {
  private readonly connections: PrismaChannelConnectionRepository;
  private readonly companies: PrismaCompanyRepository;
  private readonly audit: PrismaAuditRepository;

  constructor(
    private readonly prisma: TenantScopedPrisma,
    private readonly options: TransactionOptions = {},
  ) {
    this.connections = new PrismaChannelConnectionRepository(prisma);
    this.companies = new PrismaCompanyRepository(prisma);
    this.audit = new PrismaAuditRepository(prisma);
  }

  run<T>(fn: (tx: ChannelTransaction) => Promise<T>): Promise<T> {
    return runInTransaction(
      this.prisma,
      (db) =>
        fn({
          connections: this.connections.forTransaction(db),
          companies: this.companies.forTransaction(db),
          audit: this.audit.forTransaction(db),
          lockCompany: (companyId) => lockCompanyRow(db, companyId),
        }),
      this.options,
    );
  }
}
