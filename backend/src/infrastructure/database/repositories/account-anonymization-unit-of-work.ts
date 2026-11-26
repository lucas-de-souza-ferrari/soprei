import type {
  AccountAnonymizationTransaction,
  AccountAnonymizationUnitOfWork,
  AnonymizedMembershipRef,
} from '../../../application/ports/account-anonymization-unit-of-work.js';
import { CompanyId, MembershipId, resolveAccess } from '../../../domain/index.js';
import type { TenantScopedDb, TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { isDeadlock } from '../database-errors.js';
import { runInTransaction, type TransactionOptions } from '../transaction.js';
import { lockAccountRow, lockMemberCompanies } from './account.repository.js';
import { findSubscriptionByAccount } from './billing.repository.js';
import { PrismaPlatformAuditRepository } from './platform-audit.repository.js';
import { soleOwnerCompanyCountForRemoval } from './platform-read-model.js';

/** `password_hash` de conta excluída: não é um hash válido, então nenhuma senha confere (spec 032, E7). */
export const DELETED_ACCOUNT_PASSWORD_HASH = 'account-deleted';
/** Repetições depois de um deadlock (a primeira tentativa não conta), como as unidades de trabalho da 045. */
const DEADLOCK_RETRIES = 2;

async function membershipsOf(
  db: TenantScopedDb,
  accountId: string,
): Promise<AnonymizedMembershipRef[]> {
  // `companies` é global; os vínculos são lidos empresa a empresa, com `companyId` no `where` (tenant-scope).
  const companies = await db.company.findMany({
    where: { memberships: { some: { accountId } } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const refs: AnonymizedMembershipRef[] = [];
  for (const { id } of companies) {
    const companyId = CompanyId.parse(id);
    const rows = await db.membership.findMany({
      where: { companyId, accountId },
      select: { id: true },
    });
    for (const row of rows) refs.push({ companyId, membershipId: MembershipId.parse(row.id) });
  }
  return refs;
}

/**
 * Anonimização de uma conta (spec 032, E7; spec 045, E6). Sem SQL cru novo: as travas são as que já existem
 * (`lockMemberCompanies` e `lockAccountRow` de `account.repository.ts`), a regra do único dono é a de
 * `platform-read-model.ts` (`soleOwnerCompanyCountForRemoval`) e a escrita é `updateMany` (conta, global; vínculos
 * com `companyId` no `where`). Nada é apagado: a trilha, a assinatura e os pedidos continuam ligados à linha.
 */
export class PrismaAccountAnonymizationUnitOfWork implements AccountAnonymizationUnitOfWork {
  constructor(
    private readonly prisma: TenantScopedPrisma,
    private readonly options: TransactionOptions = {},
  ) {}

  async run<T>(fn: (tx: AccountAnonymizationTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(fn);
      } catch (error) {
        if (attempt >= DEADLOCK_RETRIES || !isDeadlock(error)) throw error;
      }
    }
  }

  private once<T>(fn: (tx: AccountAnonymizationTransaction) => Promise<T>): Promise<T> {
    return runInTransaction(
      this.prisma,
      (db) => {
        const audit = new PrismaPlatformAuditRepository(db);
        return fn({
          lockMemberCompanies: (accountId) => lockMemberCompanies(db, accountId),
          lockAccount: async (accountId) => {
            if (!(await lockAccountRow(db, accountId))) return null;
            const row = await db.account.findFirst({
              where: { id: accountId },
              select: { email: true, status: true, emailVerifiedAt: true },
            });
            if (row === null) return null;
            return {
              email: row.email,
              status: row.status,
              verified: row.emailVerifiedAt !== null,
            };
          },
          soleOwnerCompanies: (accountId) => soleOwnerCompanyCountForRemoval(db, accountId),
          paidInForce: async (accountId, now) => {
            const subscription = await findSubscriptionByAccount(db, accountId);
            if (subscription === null) return false;
            // Sem carência: "período pago em vigor" é ACTIVE antes do fim e sem cancelamento marcado.
            return resolveAccess(subscription, now, 0).state === 'ACTIVE';
          },
          anonymize: async (accountId, anonymizedEmail) => {
            await db.account.updateMany({
              where: { id: accountId },
              data: {
                email: anonymizedEmail,
                passwordHash: DELETED_ACCOUNT_PASSWORD_HASH,
                status: 'DISABLED',
                lastCompanyId: null,
                verificationHash: null,
                verificationExpiresAt: null,
                verificationAttempts: 0,
                verificationFailuresDay: 0,
                verificationFailuresSince: null,
                resetHash: null,
                resetExpiresAt: null,
                resetAttempts: 0,
                resetFailuresDay: 0,
                resetFailuresSince: null,
              },
            });
            const refs = await membershipsOf(db, accountId);
            for (const { companyId, membershipId } of refs) {
              await db.membership.updateMany({
                where: { id: membershipId, companyId, accountId },
                data: {
                  email: anonymizedEmail,
                  status: 'DISABLED',
                  passwordHash: DELETED_ACCOUNT_PASSWORD_HASH,
                },
              });
            }
            return refs;
          },
          memberships: (accountId) => membershipsOf(db, accountId),
          platformAudit: async (event) => {
            await audit.create(event);
          },
        });
      },
      this.options,
    );
  }
}
