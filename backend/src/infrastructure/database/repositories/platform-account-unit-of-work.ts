import type {
  PlatformAccountTransaction,
  PlatformAccountUnitOfWork,
} from '../../../application/ports/platform-account-unit-of-work.js';
import { CompanyId, MembershipId } from '../../../domain/index.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import type { TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { isDeadlock } from '../database-errors.js';
import { runInTransaction, type TransactionOptions } from '../transaction.js';
import { lockAccountRow, lockOwnedCompanies } from './account.repository.js';
import { PrismaPlatformAuditRepository } from './platform-audit.repository.js';
import { soleActiveOwnerCompanyCount } from './platform-read-model.js';

/** Repetições depois de um deadlock (a primeira tentativa não conta). */
export const DEADLOCK_RETRIES = 2;

function accountNotFound(): NotFoundError {
  return new NotFoundError('Conta não encontrada', { context: { entity: 'Account' } });
}

/**
 * Ações do admin da plataforma sobre uma conta (spec 045, E2): travas (empresas em que a conta é dona,
 * depois a conta), releitura, regra do último dono, estado e trilha na mesma transação. Sem SQL cru novo
 * aqui: as travas são as que já existem (`lockCompanyRow` da 008 e `lockAccountRow` da criação de
 * empresa) e a regra usa o `activeOwnersFrom` da E1, em `platform-read-model.ts`. Os vínculos da conta
 * são lidos empresa a empresa, com `companyId` no `where` (`tenant-scope`).
 */
export class PrismaPlatformAccountUnitOfWork implements PlatformAccountUnitOfWork {
  constructor(
    private readonly prisma: TenantScopedPrisma,
    private readonly options: TransactionOptions = {},
  ) {}

  /**
   * Repete a transação inteira em deadlock (40P01), até `DEADLOCK_RETRIES` vezes: defesa para qualquer
   * transação que trave na ordem inversa (o `createCompany` da 031 já segue empresas -> conta); o callback
   * não faz nada externo, então repetir é seguro.
   */
  async run<T>(fn: (tx: PlatformAccountTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(fn);
      } catch (error) {
        if (attempt >= DEADLOCK_RETRIES || !isDeadlock(error)) throw error;
      }
    }
  }

  private once<T>(fn: (tx: PlatformAccountTransaction) => Promise<T>): Promise<T> {
    return runInTransaction(
      this.prisma,
      (db) => {
        const audit = new PrismaPlatformAuditRepository(db);
        return fn({
          lockOwnedCompanies: (accountId) => lockOwnedCompanies(db, accountId),
          lockAccount: async (accountId) => {
            if (!(await lockAccountRow(db, accountId))) throw accountNotFound();
            const row = await db.account.findFirst({
              where: { id: accountId },
              select: { status: true, emailVerifiedAt: true },
            });
            if (row === null) throw accountNotFound();
            return { status: row.status, verified: row.emailVerifiedAt !== null };
          },
          soleActiveOwnerCompanies: (accountId) => soleActiveOwnerCompanyCount(db, accountId),
          setStatus: async (accountId, status) => {
            await db.account.updateMany({ where: { id: accountId }, data: { status } });
          },
          memberships: async (accountId) => {
            const companies = await db.company.findMany({
              where: { memberships: { some: { accountId } } },
              select: { id: true },
              orderBy: { id: 'asc' },
            });
            const refs = [];
            for (const { id } of companies) {
              const companyId = CompanyId.parse(id);
              const rows = await db.membership.findMany({
                where: { companyId, accountId },
                select: { id: true },
              });
              for (const row of rows) {
                refs.push({ companyId, membershipId: MembershipId.parse(row.id) });
              }
            }
            return refs;
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
