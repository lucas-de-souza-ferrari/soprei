import type {
  InvitationAccount,
  InvitationActor,
  InvitationTransaction,
  InvitationUnitOfWork,
} from '../../../application/ports/invitation-unit-of-work.js';
import { type CompanyId, type CompanyStatus, type MembershipRole } from '../../../domain/index.js';
import { ConflictError, NotFoundError } from '../../../shared/errors/index.js';
import { isUuid } from '../../../shared/utils/index.js';
import type { TenantScopedDb, TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { runInTransaction, type TransactionOptions } from '../transaction.js';
import { PrismaAuditRepository } from './audit.repository.js';
import { PrismaCompanyInvitationRepository } from './company-invitation.repository.js';
import { PrismaCompanyRepository } from './company.repository.js';
import { PrismaPlatformAuditRepository } from './platform-audit.repository.js';

/** Valor fixo do `password_hash` do vínculo de conta global (o mesmo que a 017 grava). */
const ACCOUNT_MANAGED = 'account-managed';

interface AccountRow {
  id: string;
  email: string;
  status: 'ACTIVE' | 'DISABLED';
  emailVerifiedAt: Date | null;
}

/**
 * Trava a linha da empresa até o fim da transação (mesmo `FOR NO KEY UPDATE` da gestão de membros,
 * então criar, reenviar, revogar e aceitar convites e mudar papel/estado de membro se serializam).
 * SQL **controlado**: parametrizado por `companyId` (cast para uuid), numa tabela global.
 */
async function lockCompanyRow(
  db: TenantScopedDb,
  companyId: CompanyId,
): Promise<{ status: CompanyStatus; name: string }> {
  const rows = await db.$queryRaw<{ status: CompanyStatus; name: string }[]>`
    SELECT status, name FROM companies
    WHERE id = ${companyId}::uuid AND deleted_at IS NULL FOR NO KEY UPDATE`;
  const row = rows[0];
  if (row === undefined) {
    throw new NotFoundError('Empresa não encontrada', { context: { entity: 'Company' } });
  }
  return { status: row.status, name: row.name };
}

function toAccount(row: AccountRow | undefined): InvitationAccount | null {
  return row === undefined
    ? null
    : {
        id: row.id,
        email: row.email,
        status: row.status,
        emailVerifiedAt: row.emailVerifiedAt,
      };
}

/**
 * Transação dos convites (spec 025): convite, auditoria, vínculo e conta sobre a mesma transação, com o
 * bloqueio da empresa e, depois dele, o da conta (ordem fixa: não há ciclo com `createCompany`, que só
 * trava conta). SQL cru só em `accounts` (global) e em `companies` (bloqueio), tudo parametrizado.
 */
export class PrismaInvitationUnitOfWork implements InvitationUnitOfWork {
  constructor(
    private readonly prisma: TenantScopedPrisma,
    private readonly options: TransactionOptions = {},
  ) {}

  run<T>(fn: (tx: InvitationTransaction) => Promise<T>): Promise<T> {
    return runInTransaction(this.prisma, (db) => fn(this.transaction(db)), this.options);
  }

  private transaction(db: TenantScopedDb): InvitationTransaction {
    return {
      invitations: new PrismaCompanyInvitationRepository(db),
      audit: new PrismaAuditRepository(db),
      lockCompany: (companyId) => lockCompanyRow(db, companyId),
      actor: async (companyId, membershipId): Promise<InvitationActor | null> => {
        if (!isUuid(membershipId)) return null;
        const row = await db.membership.findFirst({
          where: { companyId, id: membershipId },
          select: { id: true, role: true, status: true, accountId: true },
        });
        return row === null
          ? null
          : { id: row.id, role: row.role, status: row.status, accountId: row.accountId };
      },
      hasMemberWithEmail: async (companyId, email) =>
        (await db.membership.findFirst({
          where: { companyId, email },
          select: { id: true },
        })) !== null,
      hasMembershipForAccount: async (companyId, accountId) =>
        (await db.membership.findFirst({
          where: { companyId, accountId },
          select: { id: true },
        })) !== null,
      lockAccountByEmail: async (email) => {
        const rows = await db.$queryRaw<AccountRow[]>`
          SELECT id, email, status, email_verified_at AS "emailVerifiedAt"
          FROM accounts WHERE email = ${email} FOR NO KEY UPDATE`;
        return toAccount(rows[0]);
      },
      lockAccountById: async (id) => {
        const rows = await db.$queryRaw<AccountRow[]>`
          SELECT id, email, status, email_verified_at AS "emailVerifiedAt"
          FROM accounts WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
        return toAccount(rows[0]);
      },
      createConfirmedAccount: async ({ id, email, passwordHash, now }) => {
        // O e-mail é único: se outra transação o criou no meio, não grava nada (quem chama relê).
        const rows = await db.$queryRaw<{ id: string }[]>`
          INSERT INTO accounts (id, email, password_hash, email_verified_at)
          VALUES (${id}::uuid, ${email}, ${passwordHash}, ${now}::timestamptz)
          ON CONFLICT (email) DO NOTHING
          RETURNING id`;
        return rows.length === 1;
      },
      confirmUnverifiedAccount: async (id, passwordHash, now) => {
        // Quem prova o e-mail define a senha: confirma, SUBSTITUI o hash e mata os códigos pendentes.
        const rows = await db.$queryRaw<{ id: string }[]>`
          UPDATE accounts
          SET password_hash = ${passwordHash},
              email_verified_at = ${now}::timestamptz,
              verification_hash = NULL,
              verification_expires_at = NULL,
              verification_attempts = 0,
              verification_failures_day = 0,
              verification_failures_since = NULL,
              reset_hash = NULL,
              reset_expires_at = NULL,
              reset_attempts = 0,
              reset_failures_day = 0,
              reset_failures_since = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ${id}::uuid
            AND email_verified_at IS NULL
            AND status = 'ACTIVE'
          RETURNING id`;
        return rows.length === 1;
      },
      adminStatus: async (adminId) => {
        if (!isUuid(adminId)) return null;
        const row = await db.platformAdmin.findFirst({
          where: { id: adminId },
          select: { status: true },
        });
        return row?.status ?? null;
      },
      countPlatformSends: (companyId, since) =>
        db.platformAuditEvent.count({
          where: {
            subjectCompanyId: companyId,
            action: { in: ['INVITATION_CREATED_BY_PLATFORM', 'INVITATION_RESENT_BY_PLATFORM'] },
            createdAt: { gte: since },
          },
        }),
      platformAudit: async (event) => {
        await new PrismaPlatformAuditRepository(db).create(event);
      },
      createCompany: async ({ name, slug }) => {
        // O slug é único em todas as linhas (removidas inclusive): repetido vira ConflictError no repositório.
        try {
          return (await new PrismaCompanyRepository(db).create({ name, slug })).id;
        } catch (error) {
          if (error instanceof ConflictError) {
            throw new ConflictError('Já existe uma empresa com este slug', {
              code: 'SLUG_TAKEN',
              cause: error,
            });
          }
          throw error;
        }
      },
      createMembership: async (
        companyId,
        input: { accountId: string; email: string; role: MembershipRole },
      ) => {
        const row = await db.membership.create({
          data: {
            companyId,
            accountId: input.accountId,
            email: input.email,
            passwordHash: ACCOUNT_MANAGED,
            role: input.role,
          },
        });
        return { id: row.id };
      },
    };
  }
}
