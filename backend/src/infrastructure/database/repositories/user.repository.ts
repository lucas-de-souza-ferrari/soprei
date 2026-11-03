import type {
  ClientId,
  NewUser,
  User,
  UserCredentials,
  UserRepository,
  UserUpdate,
} from '../../../domain/index.js';
import type { User as UserRow } from '../../../generated/prisma/client.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import { isUuid } from '../../../shared/utils/index.js';
import type { TenantScopedDb } from '../extensions/tenant-scope.js';
import { toUser } from './mappers.js';
import { PrismaTenantRepository, type TenantModelOps } from './tenant.repository.base.js';

function userOps(db: TenantScopedDb): TenantModelOps<UserRow, NewUser, UserUpdate> {
  return {
    findFirst: (where) => db.user.findFirst({ where }),
    findMany: ({ where, orderBy, take }) => db.user.findMany({ where, orderBy, take }),
    create: (data) =>
      db.user.create({
        data: {
          clientId: data.clientId,
          email: data.email,
          passwordHash: data.passwordHash,
          ...(data.role === undefined ? {} : { role: data.role }),
          ...(data.status === undefined ? {} : { status: data.status }),
        },
      }),
    updateMany: (where, data) =>
      db.user.updateMany({
        where,
        data: {
          ...(data.role === undefined ? {} : { role: data.role }),
          ...(data.status === undefined ? {} : { status: data.status }),
        },
      }),
    deleteMany: (where) => db.user.deleteMany({ where }),
    count: (where) => db.user.count({ where }),
  };
}

/**
 * Usuários de um cliente (spec 007). Mesmas garantias da base de tenant; o hash da senha só sai
 * em `findCredentialsByEmail` (tipo `UserCredentials`) e nunca em `User`.
 */
export class PrismaUserRepository
  extends PrismaTenantRepository<UserRow, User, NewUser, UserUpdate>
  implements UserRepository
{
  constructor(private readonly db: TenantScopedDb) {
    super({ entity: 'User', ops: userOps(db), map: toUser });
  }

  forTransaction(tx: TenantScopedDb): UserRepository {
    return new PrismaUserRepository(tx);
  }

  findCredentialsByEmail(clientId: ClientId, email: string): Promise<UserCredentials | null> {
    return this.run('findCredentialsByEmail', async () => {
      const row = await this.db.user.findFirst({ where: { clientId, email } });
      return row === null ? null : { user: toUser(row), passwordHash: row.passwordHash };
    });
  }

  findCredentialsById(clientId: ClientId, id: string): Promise<UserCredentials> {
    return this.run('findCredentialsById', async () => {
      if (!isUuid(id)) throw notFound();
      const row = await this.db.user.findFirst({ where: { clientId, id } });
      if (row === null) throw notFound();
      return { user: toUser(row), passwordHash: row.passwordHash };
    });
  }

  countActiveOwners(clientId: ClientId): Promise<number> {
    return this.run('countActiveOwners', () =>
      this.db.user.count({ where: { clientId, role: 'OWNER', status: 'ACTIVE' } }),
    );
  }

  updatePassword(clientId: ClientId, id: string, passwordHash: string): Promise<void> {
    return this.run('updatePassword', async () => {
      if (!isUuid(id)) throw notFound();
      const { count } = await this.db.user.updateMany({
        where: { id, clientId },
        data: { passwordHash },
      });
      if (count === 0) throw notFound();
    });
  }
}

function notFound(): NotFoundError {
  return new NotFoundError('Recurso não encontrado', { context: { entity: 'User' } });
}
