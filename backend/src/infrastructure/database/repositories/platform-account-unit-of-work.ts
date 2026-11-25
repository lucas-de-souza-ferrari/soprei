import type {
  PlatformAccountTransaction,
  PlatformAccountUnitOfWork,
} from '../../../application/ports/platform-account-unit-of-work.js';
import { CompanyId, MembershipId } from '../../../domain/index.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import type { TenantScopedDb, TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { runInTransaction, type TransactionOptions } from '../transaction.js';
import { lockAccountRow } from './account.repository.js';
import { lockCompanyRow } from './membership-admin-unit-of-work.js';
import { PrismaPlatformAuditRepository } from './platform-audit.repository.js';
import { soleActiveOwnerCompanyCount } from './platform-read-model.js';

function accountNotFound(): NotFoundError {
  return new NotFoundError('Conta não encontrada', { context: { entity: 'Account' } });
}

/** Trava, em ordem de id, as empresas não removidas em que a conta tem vínculo `OWNER` ativo. */
async function lockOwnedCompanies(db: TenantScopedDb, accountId: string): Promise<number> {
  // `companies` é global; o filtro pelo vínculo é relação (`some`), como em `listMemberships`.
  const companies = await db.company.findMany({
    where: {
      deletedAt: null,
      memberships: { some: { accountId, role: 'OWNER', status: 'ACTIVE' } },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  let locked = 0;
  for (const { id } of companies) {
    try {
      await lockCompanyRow(db, CompanyId.parse(id));
      locked += 1;
    } catch (error) {
      // Removida entre a leitura e a trava: não conta para a regra do último dono (só empresa ativa e
      // não removida), então segue sem ela.
      if (!(error instanceof NotFoundError)) throw error;
    }
  }
  return locked;
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

  run<T>(fn: (tx: PlatformAccountTransaction) => Promise<T>): Promise<T> {
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
