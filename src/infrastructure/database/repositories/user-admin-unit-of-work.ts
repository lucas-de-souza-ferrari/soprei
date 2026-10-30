import type {
  UserAdminTransaction,
  UserAdminUnitOfWork,
} from '../../../application/ports/user-admin-unit-of-work.js';
import type { ClientId } from '../../../domain/index.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import type { TenantScopedDb, TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { runInTransaction, type TransactionOptions } from '../transaction.js';
import { PrismaAuditRepository } from './audit.repository.js';
import { PrismaUserRepository } from './user.repository.js';

/**
 * Trava a linha do cliente até o fim da transação. SQL **controlado**: um único `SELECT ... FOR
 * UPDATE` parametrizado por `clientId` (cast para uuid; nenhum valor concatenado), numa tabela
 * global (`clients`), que a `tenant-scope` não intercepta. Quem chama pelo `lockClient` já recebeu
 * o `ClientId` do token.
 */
async function lockClientRow(db: TenantScopedDb, clientId: ClientId): Promise<void> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM clients WHERE id = ${clientId}::uuid AND deleted_at IS NULL FOR UPDATE`;
  if (rows.length === 0) {
    throw new NotFoundError('Cliente não encontrado', { context: { entity: 'Client' } });
  }
}

/**
 * Transação da gestão de usuários (spec 008): usuários e auditoria sobre o mesmo client
 * transacional, mais o bloqueio do cliente que serializa a regra do último `OWNER`. O callback não
 * deve fazer chamada externa (hash, Redis): a transação segura uma conexão e o bloqueio.
 */
export class PrismaUserAdminUnitOfWork implements UserAdminUnitOfWork {
  private readonly users: PrismaUserRepository;
  private readonly audit: PrismaAuditRepository;

  constructor(
    private readonly prisma: TenantScopedPrisma,
    private readonly options: TransactionOptions = {},
  ) {
    this.users = new PrismaUserRepository(prisma);
    this.audit = new PrismaAuditRepository(prisma);
  }

  run<T>(fn: (tx: UserAdminTransaction) => Promise<T>): Promise<T> {
    return runInTransaction(
      this.prisma,
      (db) =>
        fn({
          users: this.users.forTransaction(db),
          audit: this.audit.forTransaction(db),
          lockClient: (clientId) => lockClientRow(db, clientId),
        }),
      this.options,
    );
  }
}
