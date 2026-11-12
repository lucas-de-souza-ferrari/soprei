import type {
  ChannelConnection,
  ChannelConnectionRepository,
  ChannelConnectionUpdate,
  CompanyId,
  NewChannelConnection,
} from '../../../domain/index.js';
import { DatabaseError } from '../../../shared/errors/index.js';
import type { ChannelConnection as ChannelConnectionRow } from '../../../generated/prisma/client.js';
import type { TenantScopedDb } from '../extensions/tenant-scope.js';
import { toChannelConnection } from './mappers.js';
import { PrismaTenantRepository, type TenantModelOps } from './tenant.repository.base.js';

function connectionOps(
  db: TenantScopedDb,
): TenantModelOps<ChannelConnectionRow, NewChannelConnection, ChannelConnectionUpdate> {
  return {
    findFirst: (where) => db.channelConnection.findFirst({ where }),
    findMany: ({ where, orderBy, take }) => db.channelConnection.findMany({ where, orderBy, take }),
    create: (data) =>
      db.channelConnection.create({
        data: {
          companyId: data.companyId,
          wabaId: data.wabaId,
          tokenCiphertext: data.tokenCiphertext,
          tokenExpiresAt: data.tokenExpiresAt ?? null,
          mode: data.mode,
          registrationPinCiphertext: data.registrationPinCiphertext ?? null,
        },
      }),
    updateMany: (where, data) =>
      db.channelConnection.updateMany({
        where,
        data: {
          ...(data.wabaId === undefined ? {} : { wabaId: data.wabaId }),
          ...(data.tokenCiphertext === undefined ? {} : { tokenCiphertext: data.tokenCiphertext }),
          ...(data.tokenExpiresAt === undefined ? {} : { tokenExpiresAt: data.tokenExpiresAt }),
        },
      }),
    deleteMany: (where) => db.channelConnection.deleteMany({ where }),
    count: (where) => db.channelConnection.count({ where }),
  };
}

/**
 * Credencial do canal por empresa (spec 015). Mesmas garantias da base de tenant (`companyId` em todo
 * `where`, nunca `findUnique`/`upsert`); o texto cifrado só sai na entidade para o serviço de
 * credenciais, que o decifra com o `companyId` (AAD).
 */
export class PrismaChannelConnectionRepository
  extends PrismaTenantRepository<
    ChannelConnectionRow,
    ChannelConnection,
    NewChannelConnection,
    ChannelConnectionUpdate
  >
  implements ChannelConnectionRepository
{
  constructor(private readonly db: TenantScopedDb) {
    super({ entity: 'ChannelConnection', ops: connectionOps(db), map: toChannelConnection });
  }

  forTransaction(tx: TenantScopedDb): ChannelConnectionRepository {
    return new PrismaChannelConnectionRepository(tx);
  }

  find(companyId: CompanyId): Promise<ChannelConnection | null> {
    return this.run('find', async () => {
      const row = await this.db.channelConnection.findFirst({ where: { companyId } });
      return row === null ? null : toChannelConnection(row);
    });
  }

  save(
    companyId: CompanyId,
    data: NewChannelConnection,
  ): Promise<{ readonly connection: ChannelConnection; readonly replaced: boolean }> {
    return this.run('save', async () => {
      const existing = await this.db.channelConnection.findFirst({ where: { companyId } });
      if (existing === null) {
        const row = await this.db.channelConnection.create({
          data: {
            companyId,
            wabaId: data.wabaId,
            tokenCiphertext: data.tokenCiphertext,
            tokenExpiresAt: data.tokenExpiresAt,
            mode: data.mode,
            registrationPinCiphertext: data.registrationPinCiphertext ?? null,
          },
        });
        return { connection: toChannelConnection(row), replaced: false };
      }
      await this.db.channelConnection.updateMany({
        where: { companyId },
        data: {
          wabaId: data.wabaId,
          tokenCiphertext: data.tokenCiphertext,
          tokenExpiresAt: data.tokenExpiresAt,
          mode: data.mode,
          ...(data.registrationPinCiphertext === undefined
            ? {}
            : { registrationPinCiphertext: data.registrationPinCiphertext }),
          tokenVersion: { increment: 1 },
          status: 'CONNECTED',
          tokenInvalidAt: null,
        },
      });
      const row = await this.db.channelConnection.findFirst({ where: { companyId } });
      // Só acontece se a conexão foi removida entre o update e a leitura (a transação do canal
      // serializa por `lockCompany`, então é falha de infraestrutura, não de entrada).
      if (row === null) {
        throw new DatabaseError('Conexão do canal sumiu durante a gravação', {
          context: { entity: 'ChannelConnection' },
        });
      }
      return { connection: toChannelConnection(row), replaced: true };
    });
  }

  markTokenInvalid(companyId: CompanyId, tokenVersion: number, at: Date): Promise<boolean> {
    return this.run('markTokenInvalid', async () => {
      const { count } = await this.db.channelConnection.updateMany({
        where: { companyId, tokenVersion, status: 'CONNECTED' },
        data: { status: 'TOKEN_INVALID', tokenInvalidAt: at },
      });
      return count > 0;
    });
  }

  removeByCompany(companyId: CompanyId): Promise<boolean> {
    return this.run('removeByCompany', async () => {
      const { count } = await this.db.channelConnection.deleteMany({ where: { companyId } });
      return count > 0;
    });
  }
}
