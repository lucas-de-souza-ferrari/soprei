import type {
  PlatformCompanyTransaction,
  PlatformCompanyUnitOfWork,
} from '../../../application/ports/platform-company-unit-of-work.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import type { TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { runInTransaction, type TransactionOptions } from '../transaction.js';
import { PrismaCompanyRepository } from './company.repository.js';
import { lockCompanyRow } from './membership-admin-unit-of-work.js';
import { PrismaPlatformAuditRepository } from './platform-audit.repository.js';
import { activeOwnerCount } from './platform-read-model.js';

function companyNotFound(): NotFoundError {
  return new NotFoundError('Empresa não encontrada', { context: { entity: 'Company' } });
}

/**
 * Ações do admin da plataforma sobre uma empresa (spec 044, E2; spec 045, E3a): trava, releitura, estado e
 * trilha na mesma transação. Sem SQL cru novo: a trava é a da gestão de usuários (`lockCompanyRow`, spec
 * 008), o soft delete é o do `PrismaCompanyRepository.delete`, a regra do último dono usa o
 * `activeOwnerCount` de `platform-read-model.ts` (o mesmo "dono ativo" da E1) e o resto é
 * `findFirst`/`updateMany` com `companyId` no `where` dos models de tenant (`tenant-scope`).
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
        const companies = new PrismaCompanyRepository(db);
        return fn({
          lockCompany: async (companyId) => {
            await lockCompanyRow(db, companyId);
            const row = await db.company.findFirst({
              where: { id: companyId, deletedAt: null },
              select: { status: true },
            });
            if (row === null) throw companyNotFound();
            return row.status;
          },
          company: async (companyId) => {
            const row = await db.company.findFirst({
              where: { id: companyId, deletedAt: null },
              select: { status: true, name: true, slug: true },
            });
            if (row === null) throw companyNotFound();
            return row;
          },
          setStatus: async (companyId, status) => {
            await db.company.updateMany({
              where: { id: companyId, deletedAt: null },
              data: { status },
            });
          },
          rename: async (companyId, name) => {
            await db.company.updateMany({
              where: { id: companyId, deletedAt: null },
              data: { name },
            });
          },
          remove: async (companyId, now) => {
            const connection = await db.channelConnection.findFirst({
              where: { companyId },
              select: { wabaId: true, tokenCiphertext: true },
            });
            // O soft delete de sempre: deletedAt, número liberado e a conexão apagada.
            await companies.delete(companyId);
            // Convites pendentes não valem mais: fechados como REVOKED, sem e-mail nem hash (CHECK da 025).
            await db.companyInvitation.updateMany({
              where: { companyId, status: 'PENDING' },
              data: { status: 'REVOKED', closedAt: now, email: null, tokenHash: null },
            });
            return connection;
          },
          state: async (companyId) => {
            const row = await db.company.findFirst({
              where: { id: companyId },
              select: { slug: true, deletedAt: true, whatsappPhoneNumberId: true },
            });
            if (row === null) return null;
            const connections = await db.channelConnection.count({ where: { companyId } });
            return {
              slug: row.slug,
              removed: row.deletedAt !== null,
              hasChannel: row.whatsappPhoneNumberId !== null || connections > 0,
            };
          },
          restore: async (companyId) => {
            const { count } = await db.company.updateMany({
              where: { id: companyId, deletedAt: { not: null } },
              data: { deletedAt: null },
            });
            return count === 1;
          },
          membership: async (companyId, membershipId) => {
            const row = await db.membership.findFirst({
              where: { id: membershipId, companyId },
              select: {
                role: true,
                status: true,
                account: { select: { status: true, emailVerifiedAt: true } },
              },
            });
            if (row === null) return null;
            return {
              role: row.role,
              status: row.status,
              account:
                row.account === null
                  ? null
                  : { status: row.account.status, verified: row.account.emailVerifiedAt !== null },
            };
          },
          setMembershipRole: async (companyId, membershipId, role) => {
            await db.membership.updateMany({
              where: { id: membershipId, companyId },
              data: { role },
            });
          },
          setMembershipStatus: async (companyId, membershipId, status) => {
            await db.membership.updateMany({
              where: { id: membershipId, companyId },
              data: { status },
            });
          },
          activeOwners: (companyId) => activeOwnerCount(db, companyId),
          audit: async (event) => {
            await audit.create(event);
          },
        });
      },
      this.options,
    );
  }
}
