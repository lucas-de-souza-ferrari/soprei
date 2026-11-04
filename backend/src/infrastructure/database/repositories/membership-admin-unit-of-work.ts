import type {
  MembershipAdminTransaction,
  MembershipAdminUnitOfWork,
} from '../../../application/ports/membership-admin-unit-of-work.js';
import type { CompanyId } from '../../../domain/index.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import type { TenantScopedDb, TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { runInTransaction, type TransactionOptions } from '../transaction.js';
import { PrismaAuditRepository } from './audit.repository.js';
import { PrismaMembershipRepository } from './membership.repository.js';

/**
 * Trava a linha da empresa até o fim da transação. SQL **controlado**: um único `SELECT ... FOR
 * NO KEY UPDATE` parametrizado por `companyId` (cast para uuid; nenhum valor concatenado), numa tabela
 * global (`companies`), que a `tenant-scope` não intercepta. Quem chama pelo `lockCompany` já recebeu
 * o `CompanyId` do token.
 *
 * `FOR NO KEY UPDATE` (e não `FOR UPDATE`): continua excluindo outro `FOR NO KEY UPDATE` (as
 * operações de gestão do mesma empresa seguem serializadas), mas não bloqueia o `FOR KEY SHARE` que
 * as chaves estrangeiras tomam em `companies` quando se grava mensagem, conversa ou usuário.
 */
async function lockCompanyRow(db: TenantScopedDb, companyId: CompanyId): Promise<void> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM companies WHERE id = ${companyId}::uuid AND deleted_at IS NULL FOR NO KEY UPDATE`;
  if (rows.length === 0) {
    throw new NotFoundError('Empresa não encontrada', { context: { entity: 'Company' } });
  }
}

/**
 * Transação da gestão de usuários (spec 008): usuários e auditoria sobre o mesmo company
 * transacional, mais o bloqueio da empresa que serializa a regra do último `OWNER`. O callback não
 * deve fazer chamada externa (hash, Redis): a transação segura uma conexão e o bloqueio.
 */
export class PrismaMembershipAdminUnitOfWork implements MembershipAdminUnitOfWork {
  private readonly memberships: PrismaMembershipRepository;
  private readonly audit: PrismaAuditRepository;

  constructor(
    private readonly prisma: TenantScopedPrisma,
    private readonly options: TransactionOptions = {},
  ) {
    this.memberships = new PrismaMembershipRepository(prisma);
    this.audit = new PrismaAuditRepository(prisma);
  }

  run<T>(fn: (tx: MembershipAdminTransaction) => Promise<T>): Promise<T> {
    return runInTransaction(
      this.prisma,
      (db) =>
        fn({
          memberships: this.memberships.forTransaction(db),
          audit: this.audit.forTransaction(db),
          lockCompany: (companyId) => lockCompanyRow(db, companyId),
        }),
      this.options,
    );
  }
}
