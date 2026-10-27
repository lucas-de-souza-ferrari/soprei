import type {
  Client,
  ClientId,
  ClientRepository,
  ClientUpdate,
  ListOptions,
  NewClient,
  Page,
} from '../../../domain/index.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import { buildPageQuery, stableOrderBy, toPage } from './cursor.js';
import { toClient } from './mappers.js';
import { withRepositoryErrors } from './repository-errors.js';
import type { TenantScopedDb } from '../extensions/tenant-scope.js';

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
      const { count } = await this.db.client.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (count === 0) throw notFound();
    });
  }
}

function notFound(): NotFoundError {
  return new NotFoundError('Cliente não encontrado', { context: { entity: 'Client' } });
}
