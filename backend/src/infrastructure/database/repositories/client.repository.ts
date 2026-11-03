import type {
  Client,
  ClientId,
  ClientRepository,
  ClientUpdate,
  ListOptions,
  NewClient,
  Page,
} from '../../../domain/index.js';
import { WHATSAPP_PHONE_NUMBER_ID_PATTERN } from '../../../domain/index.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import { buildPageQuery, stableOrderBy, toPage } from './cursor.js';
import { toClient } from './mappers.js';
import { withRepositoryErrors } from './repository-errors.js';
import type { TenantScopedDb, TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { runInTransaction } from '../transaction.js';

/**
 * `Client` é a raiz do tenant (model global): não é filtrado por `clientId`. Clientes
 * removidos (soft delete, `deletedAt`) somem de buscas e listagens, mas a linha continua e
 * o slug fica reservado para sempre (a unicidade do banco vale para todas as linhas).
 */
export class PrismaClientRepository implements ClientRepository {
  constructor(private readonly db: TenantScopedDb) {}

  /** O mesmo repositório sobre o client de uma transação (`runInTransaction`). */
  forTransaction(tx: TenantScopedDb): ClientRepository {
    return new PrismaClientRepository(tx);
  }

  findById(id: ClientId): Promise<Client> {
    return withRepositoryErrors('Client.findById', async () => {
      const row = await this.db.client.findFirst({ where: { id, deletedAt: null } });
      if (row === null) throw notFound();
      return toClient(row);
    });
  }

  findBySlug(slug: string): Promise<Client> {
    return withRepositoryErrors('Client.findBySlug', async () => {
      const row = await this.db.client.findFirst({ where: { slug, deletedAt: null } });
      if (row === null) throw notFound();
      return toClient(row);
    });
  }

  findByWhatsappPhoneNumberId(phoneNumberId: string): Promise<Client | null> {
    return withRepositoryErrors('Client.findByWhatsappPhoneNumberId', async () => {
      // Formato inválido nunca casa com nada: não vai ao banco. Cliente removido não aparece.
      if (!WHATSAPP_PHONE_NUMBER_ID_PATTERN.test(phoneNumberId)) return null;
      const row = await this.db.client.findFirst({
        where: { whatsappPhoneNumberId: phoneNumberId, deletedAt: null },
      });
      return row === null ? null : toClient(row);
    });
  }

  list(options?: ListOptions): Promise<Page<Client>> {
    return withRepositoryErrors('Client.list', async () => {
      const { limit, take, after } = buildPageQuery(options);
      const rows = await this.db.client.findMany({
        where: { deletedAt: null, ...(after === undefined ? {} : { OR: after }) },
        orderBy: stableOrderBy(),
        take,
      });
      return toPage(rows, limit, toClient);
    });
  }

  create(data: NewClient): Promise<Client> {
    return withRepositoryErrors('Client.create', async () => {
      const row = await this.db.client.create({
        data: {
          name: data.name,
          slug: data.slug,
          ...(data.status === undefined ? {} : { status: data.status }),
        },
      });
      return toClient(row);
    });
  }

  update(id: ClientId, data: ClientUpdate): Promise<Client> {
    return withRepositoryErrors('Client.update', async () => {
      const { count } = await this.db.client.updateMany({
        where: { id, deletedAt: null },
        data: {
          ...(data.name === undefined ? {} : { name: data.name }),
          ...(data.status === undefined ? {} : { status: data.status }),
          ...(data.persona === undefined ? {} : { persona: data.persona }),
          ...(data.whatsappPhoneNumberId === undefined
            ? {}
            : { whatsappPhoneNumberId: data.whatsappPhoneNumberId }),
        },
      });
      if (count === 0) throw notFound();
      const row = await this.db.client.findFirst({ where: { id, deletedAt: null } });
      if (row === null) throw notFound();
      return toClient(row);
    });
  }

  delete(id: ClientId): Promise<void> {
    return withRepositoryErrors('Client.delete', async () => {
      const remove = async (db: TenantScopedDb): Promise<void> => {
        const { count } = await db.client.updateMany({
          where: { id, deletedAt: null },
          // O número do WhatsApp é liberado junto: um cliente removido não recebe mais mensagens e o
          // número pode ser ligado a outro cliente.
          data: { deletedAt: new Date(), whatsappPhoneNumberId: null },
        });
        if (count === 0) throw notFound();
        // Spec 015: a credencial do canal (texto cifrado) some na mesma transação.
        await db.channelConnection.deleteMany({ where: { clientId: id } });
      };
      // Fora de uma transação (client raiz) abre uma; dentro de uma, já está nela.
      if ('$transaction' in this.db) {
        await runInTransaction(this.db as TenantScopedPrisma, remove);
      } else {
        await remove(this.db);
      }
    });
  }
}

function notFound(): NotFoundError {
  return new NotFoundError('Cliente não encontrado', { context: { entity: 'Client' } });
}
