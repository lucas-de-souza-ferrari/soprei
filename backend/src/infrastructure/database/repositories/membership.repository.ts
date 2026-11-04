import type {
  CompanyId,
  NewMembership,
  Membership,
  MembershipCredentials,
  MembershipRepository,
  MembershipUpdate,
} from '../../../domain/index.js';
import type { Membership as MembershipRow } from '../../../generated/prisma/client.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import { isUuid } from '../../../shared/utils/index.js';
import type { TenantScopedDb } from '../extensions/tenant-scope.js';
import { toMembership } from './mappers.js';
import { PrismaTenantRepository, type TenantModelOps } from './tenant.repository.base.js';

function membershipOps(
  db: TenantScopedDb,
): TenantModelOps<MembershipRow, NewMembership, MembershipUpdate> {
  return {
    findFirst: (where) => db.membership.findFirst({ where }),
    findMany: ({ where, orderBy, take }) => db.membership.findMany({ where, orderBy, take }),
    create: (data) =>
      db.membership.create({
        data: {
          companyId: data.companyId,
          email: data.email,
          passwordHash: data.passwordHash,
          ...(data.role === undefined ? {} : { role: data.role }),
          ...(data.status === undefined ? {} : { status: data.status }),
        },
      }),
    updateMany: (where, data) =>
      db.membership.updateMany({
        where,
        data: {
          ...(data.role === undefined ? {} : { role: data.role }),
          ...(data.status === undefined ? {} : { status: data.status }),
        },
      }),
    deleteMany: (where) => db.membership.deleteMany({ where }),
    count: (where) => db.membership.count({ where }),
  };
}

/**
 * Usuários de uma empresa (spec 007). Mesmas garantias da base de tenant; o hash da senha só sai
 * em `findCredentialsByEmail` (tipo `MembershipCredentials`) e nunca em `Membership`.
 */
export class PrismaMembershipRepository
  extends PrismaTenantRepository<MembershipRow, Membership, NewMembership, MembershipUpdate>
  implements MembershipRepository
{
  constructor(private readonly db: TenantScopedDb) {
    super({ entity: 'Membership', ops: membershipOps(db), map: toMembership });
  }

  forTransaction(tx: TenantScopedDb): MembershipRepository {
    return new PrismaMembershipRepository(tx);
  }

  findCredentialsByEmail(
    companyId: CompanyId,
    email: string,
  ): Promise<MembershipCredentials | null> {
    return this.run('findCredentialsByEmail', async () => {
      const row = await this.db.membership.findFirst({ where: { companyId, email } });
      return row === null
        ? null
        : { membership: toMembership(row), passwordHash: row.passwordHash };
    });
  }

  findCredentialsById(companyId: CompanyId, id: string): Promise<MembershipCredentials> {
    return this.run('findCredentialsById', async () => {
      if (!isUuid(id)) throw notFound();
      const row = await this.db.membership.findFirst({ where: { companyId, id } });
      if (row === null) throw notFound();
      return { membership: toMembership(row), passwordHash: row.passwordHash };
    });
  }

  countActiveOwners(companyId: CompanyId): Promise<number> {
    return this.run('countActiveOwners', () =>
      this.db.membership.count({ where: { companyId, role: 'OWNER', status: 'ACTIVE' } }),
    );
  }

  updatePassword(companyId: CompanyId, id: string, passwordHash: string): Promise<void> {
    return this.run('updatePassword', async () => {
      if (!isUuid(id)) throw notFound();
      const { count } = await this.db.membership.updateMany({
        where: { id, companyId, accountId: null },
        data: { passwordHash },
      });
      if (count === 0) throw notFound();
    });
  }
}

function notFound(): NotFoundError {
  return new NotFoundError('Recurso não encontrado', { context: { entity: 'Membership' } });
}
