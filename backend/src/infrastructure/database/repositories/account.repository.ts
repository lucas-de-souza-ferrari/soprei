import { randomUUID } from 'node:crypto';
import {
  ClientId,
  AccountId,
  UserId,
  type AccountRepository,
  type AccountMembership,
} from '../../../domain/index.js';
import type { TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { runInTransaction } from '../transaction.js';
import { withRepositoryErrors } from './repository-errors.js';
import { ForbiddenError, ConflictError } from '../../../shared/errors/index.js';

export class PrismaAccountRepository implements AccountRepository {
  constructor(private readonly db: TenantScopedPrisma) {}

  findByEmail(email: string) {
    return withRepositoryErrors('Account.findByEmail', async () => {
      const row = await this.db.account.findUnique({ where: { email } });
      return row === null ? null : { ...row, id: AccountId.parse(row.id) };
    });
  }
  findById(id: string) {
    return withRepositoryErrors('Account.findById', async () => {
      const row = await this.db.account.findUnique({ where: { id } });
      return row === null ? null : { ...row, id: AccountId.parse(row.id) };
    });
  }
  create(email: string, passwordHash: string) {
    return withRepositoryErrors('Account.create', async () => {
      const row = await this.db.account.create({ data: { email, passwordHash } });
      return { ...row, id: AccountId.parse(row.id) };
    });
  }
  registerUnverified(input: {
    id: string;
    email: string;
    passwordHash: string;
    verificationHash: string;
    expiresAt: Date;
    retryBefore: Date;
  }): Promise<string | null> {
    return withRepositoryErrors('Account.register', async () => {
      // Um único INSERT ... ON CONFLICT: sem janela entre ler e gravar, e o mesmo custo de banco
      // para e-mail novo, não confirmado ou já confirmado. A substituição só ocorre na linha
      // ainda sem confirmação e depois do intervalo mínimo desde o último envio (o envio é
      // `verification_expires_at` menos a validade de 30 min).
      const rows = await this.db.$queryRaw<{ id: string }[]>`
        INSERT INTO accounts (id, email, password_hash, verification_hash, verification_expires_at)
        VALUES (${input.id}::uuid, ${input.email}, ${input.passwordHash}, ${input.verificationHash},
                ${input.expiresAt}::timestamptz)
        ON CONFLICT (email) DO UPDATE SET
          password_hash = EXCLUDED.password_hash,
          verification_hash = EXCLUDED.verification_hash,
          verification_expires_at = EXCLUDED.verification_expires_at,
          updated_at = CURRENT_TIMESTAMP
        WHERE accounts.email_verified_at IS NULL
          AND accounts.status = 'ACTIVE'
          AND (accounts.verification_expires_at IS NULL
               OR accounts.verification_expires_at <= ${input.retryBefore}::timestamptz)
        RETURNING id`;
      return rows[0]?.id ?? null;
    });
  }
  async refreshVerification(
    id: string,
    hash: string,
    expiresAt: Date,
    retryBefore: Date,
  ): Promise<boolean> {
    const { count } = await withRepositoryErrors('Account.refreshVerification', () =>
      this.db.account.updateMany({
        where: {
          id,
          emailVerifiedAt: null,
          status: 'ACTIVE',
          OR: [{ verificationExpiresAt: null }, { verificationExpiresAt: { lte: retryBefore } }],
        },
        data: { verificationHash: hash, verificationExpiresAt: expiresAt },
      }),
    );
    return count === 1;
  }
  async clearVerification(id: string, hash: string): Promise<void> {
    await withRepositoryErrors('Account.clearVerification', () =>
      this.db.account.updateMany({
        where: { id, verificationHash: hash, emailVerifiedAt: null },
        data: { verificationHash: null, verificationExpiresAt: null },
      }),
    );
  }
  async setVerification(id: string, hash: string, expiresAt: Date): Promise<void> {
    await withRepositoryErrors('Account.verification', () =>
      this.db.account.update({
        where: { id },
        data: { verificationHash: hash, verificationExpiresAt: expiresAt },
      }),
    );
  }
  async verify(id: string, hash: string, now: Date): Promise<boolean> {
    const { count } = await withRepositoryErrors('Account.verify', () =>
      this.db.account.updateMany({
        where: {
          id,
          verificationHash: hash,
          verificationExpiresAt: { gt: now },
          status: 'ACTIVE',
          emailVerifiedAt: null,
        },
        data: { emailVerifiedAt: now, verificationHash: null, verificationExpiresAt: null },
      }),
    );
    return count === 1;
  }
  async listMemberships(accountId: string): Promise<readonly AccountMembership[]> {
    // Resolve apenas raízes de tenant acessíveis. Cada leitura do vínculo continua escopada.
    const clients = await withRepositoryErrors('Account.companies', () =>
      this.db.client.findMany({
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          users: { some: { accountId, status: 'ACTIVE' } },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 100,
      }),
    );
    const result = await Promise.all(
      clients.map(({ id }) => this.membership(accountId, ClientId.parse(id))),
    );
    return result.filter((row): row is AccountMembership => row !== null);
  }
  async membership(accountId: string, clientId: ClientId): Promise<AccountMembership | null> {
    return withRepositoryErrors('Account.membership', async () => {
      const client = await this.db.client.findFirst({
        where: { id: clientId, deletedAt: null, status: 'ACTIVE' },
        select: { name: true },
      });
      if (client === null) return null;
      const user = await this.db.user.findFirst({
        where: { clientId, accountId, status: 'ACTIVE' },
        select: { id: true, role: true },
      });
      return user === null
        ? null
        : { clientId, userId: UserId.parse(user.id), name: client.name, role: user.role };
    });
  }
  async createCompany(accountId: string, name: string): Promise<AccountMembership> {
    return withRepositoryErrors('Account.createCompany', () =>
      runInTransaction(this.db, async (tx) => {
        await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR NO KEY UPDATE`;
        const account = await tx.account.findUnique({ where: { id: accountId } });
        if (account?.status !== 'ACTIVE' || account.emailVerifiedAt === null)
          throw new ForbiddenError('Conta indisponível');
        const count = await tx.client.count({ where: { users: { some: { accountId } } } });
        if (count >= 20) throw new ConflictError('Limite de 20 empresas por conta atingido');
        const client = await tx.client.create({ data: { name, slug: `empresa-${randomUUID()}` } });
        const clientId = ClientId.parse(client.id);
        const user = await tx.user.create({
          data: {
            clientId,
            accountId,
            email: account.email,
            passwordHash: 'account-managed',
            role: 'OWNER',
          },
        });
        await tx.auditEvent.create({
          data: {
            clientId,
            actorUserId: user.id,
            targetUserId: user.id,
            action: 'USER_CREATED',
            toRole: 'OWNER',
          },
        });
        return { clientId, userId: UserId.parse(user.id), name: client.name, role: user.role };
      }),
    );
  }
}
