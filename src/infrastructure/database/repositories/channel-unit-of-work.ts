import type {
  ChannelTransaction,
  ChannelUnitOfWork,
} from '../../../application/ports/channel-unit-of-work.js';
import type { ClientId } from '../../../domain/index.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import type { TenantScopedDb, TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { runInTransaction, type TransactionOptions } from '../transaction.js';
import { PrismaAuditRepository } from './audit.repository.js';
import { PrismaChannelConnectionRepository } from './channel-connection.repository.js';
import { PrismaClientRepository } from './client.repository.js';

/**
 * Trava a linha do cliente até o fim da transação: mesmo SQL controlado da gestão de usuários
 * (`SELECT ... FOR NO KEY UPDATE` parametrizado, cast para uuid, tabela global `clients`).
 */
async function lockClientRow(db: TenantScopedDb, clientId: ClientId): Promise<void> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM clients WHERE id = ${clientId}::uuid AND deleted_at IS NULL FOR NO KEY UPDATE`;
  if (rows.length === 0) {
    throw new NotFoundError('Cliente não encontrado', { context: { entity: 'Client' } });
  }
}

/** Transação do canal (spec 015): conexão, número do cliente e auditoria sobre o mesmo client. */
export class PrismaChannelUnitOfWork implements ChannelUnitOfWork {
  private readonly connections: PrismaChannelConnectionRepository;
  private readonly clients: PrismaClientRepository;
  private readonly audit: PrismaAuditRepository;

  constructor(
    private readonly prisma: TenantScopedPrisma,
    private readonly options: TransactionOptions = {},
  ) {
    this.connections = new PrismaChannelConnectionRepository(prisma);
    this.clients = new PrismaClientRepository(prisma);
    this.audit = new PrismaAuditRepository(prisma);
  }

  run<T>(fn: (tx: ChannelTransaction) => Promise<T>): Promise<T> {
    return runInTransaction(
      this.prisma,
      (db) =>
        fn({
          connections: this.connections.forTransaction(db),
          clients: this.clients.forTransaction(db),
          audit: this.audit.forTransaction(db),
          lockClient: (clientId) => lockClientRow(db, clientId),
        }),
      this.options,
    );
  }
}
