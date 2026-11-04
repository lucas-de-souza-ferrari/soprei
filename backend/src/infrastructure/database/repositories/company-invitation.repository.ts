import {
  type CompanyId,
  type CompanyInvitation,
  type CompanyInvitationRepository,
  type InvitationClosing,
  type InvitationRenewal,
  type ListOptions,
  type NewCompanyInvitation,
  type Page,
} from '../../../domain/index.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import { isUuid } from '../../../shared/utils/index.js';
import type { TenantScopedDb } from '../extensions/tenant-scope.js';
import { buildPageQuery, stableOrderBy, toPage } from './cursor.js';
import { toCompanyInvitation } from './mappers.js';
import { withRepositoryErrors } from './repository-errors.js';

function notFound(): NotFoundError {
  return new NotFoundError('Recurso não encontrado', { context: { entity: 'CompanyInvitation' } });
}

/**
 * Convites de uma empresa (spec 025, model de tenant). Mesmas garantias da base de tenant: `companyId`
 * em **todo** `where` e em todo `create`, só `findFirst`, `findMany`, `create`, `updateMany` e `count`
 * (a `tenant-scope` recusa o resto), e id de outra empresa se comporta como inexistente. Sem SQL cru.
 * Não há `update` genérico nem `delete`: o convite só avança por `renew` e `close`.
 */
export class PrismaCompanyInvitationRepository implements CompanyInvitationRepository {
  constructor(private readonly db: TenantScopedDb) {}

  forTransaction(tx: TenantScopedDb): PrismaCompanyInvitationRepository {
    return new PrismaCompanyInvitationRepository(tx);
  }

  findById(companyId: CompanyId, id: string): Promise<CompanyInvitation> {
    return this.run('findById', async () => {
      // Id malformado nunca existe: não vai ao banco (o cast para uuid falharia com erro 500).
      if (!isUuid(id)) throw notFound();
      const row = await this.db.companyInvitation.findFirst({ where: { id, companyId } });
      if (row === null) throw notFound();
      return toCompanyInvitation(row);
    });
  }

  findPendingByEmail(companyId: CompanyId, email: string): Promise<CompanyInvitation | null> {
    return this.run('findPendingByEmail', async () => {
      const row = await this.db.companyInvitation.findFirst({
        where: { companyId, email, status: 'PENDING' },
      });
      return row === null ? null : toCompanyInvitation(row);
    });
  }

  create(companyId: CompanyId, data: NewCompanyInvitation): Promise<CompanyInvitation> {
    return this.run('create', async () => {
      const row = await this.db.companyInvitation.create({
        data: {
          companyId,
          email: data.email,
          role: data.role,
          tokenHash: data.tokenHash,
          invitedByMembershipId: data.invitedByMembershipId,
          expiresAt: data.expiresAt,
          lastSentAt: data.now,
          createdAt: data.now,
        },
      });
      return toCompanyInvitation(row);
    });
  }

  listPending(companyId: CompanyId, options?: ListOptions): Promise<Page<CompanyInvitation>> {
    return this.run('listPending', async () => {
      const { limit, take, after } = buildPageQuery(options);
      const rows = await this.db.companyInvitation.findMany({
        where: { companyId, status: 'PENDING', ...(after === undefined ? {} : { OR: after }) },
        orderBy: stableOrderBy(),
        take,
      });
      return toPage(rows, limit, toCompanyInvitation);
    });
  }

  countPending(companyId: CompanyId, now: Date): Promise<number> {
    return this.run('countPending', () =>
      this.db.companyInvitation.count({
        where: { companyId, status: 'PENDING', expiresAt: { gt: now } },
      }),
    );
  }

  renew(
    companyId: CompanyId,
    id: string,
    data: InvitationRenewal,
  ): Promise<CompanyInvitation | null> {
    return this.run('renew', async () => {
      if (!isUuid(id)) return null;
      const { count } = await this.db.companyInvitation.updateMany({
        where: { id, companyId, status: 'PENDING' },
        data: {
          tokenHash: data.tokenHash,
          expiresAt: data.expiresAt,
          lastSentAt: data.lastSentAt,
          sendCount: { increment: 1 },
        },
      });
      if (count === 0) return null;
      const row = await this.db.companyInvitation.findFirst({ where: { id, companyId } });
      return row === null ? null : toCompanyInvitation(row);
    });
  }

  close(companyId: CompanyId, id: string, closing: InvitationClosing): Promise<boolean> {
    return this.run('close', async () => {
      if (!isUuid(id)) return false;
      const { count } = await this.db.companyInvitation.updateMany({
        where: { id, companyId, status: 'PENDING' },
        // O banco exige e-mail e hash nulos fora de PENDING (CHECK): anulamos na mesma instrução.
        data: {
          status: closing.status,
          closedAt: closing.closedAt,
          email: null,
          tokenHash: null,
          acceptedMembershipId: closing.acceptedMembershipId ?? null,
        },
      });
      return count === 1;
    });
  }

  private run<R>(operation: string, fn: () => Promise<R>): Promise<R> {
    return withRepositoryErrors(`CompanyInvitation.${operation}`, fn);
  }
}
