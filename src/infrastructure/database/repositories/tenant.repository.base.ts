import type {
  ClientId,
  ListOptions,
  Page,
  TenantRepository,
  WithoutClientId,
} from '../../../domain/index.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import { isUuid } from '../../../shared/utils/index.js';
import {
  type AfterCursor,
  buildPageQuery,
  type PagedRow,
  stableOrderBy,
  type StableOrderBy,
  toPage,
} from './cursor.js';
import { withRepositoryErrors } from './repository-errors.js';
import type { TenantScopedDb } from '../extensions/tenant-scope.js';

/** Filtro que a base monta: o `clientId` está sempre presente. */
export interface TenantWhere {
  readonly id?: string;
  readonly clientId: string;
  readonly OR?: AfterCursor[];
}

/**
 * As únicas operações de banco que um repositório de tenant usa. Cada model implementa
 * isto sobre o seu delegate do Prisma (`db.conversation` etc.), só repassando o que a base
 * monta; assim a base fica sem `any` e sem depender do tipo de cada model.
 */
export interface TenantModelOps<TRow extends PagedRow, TCreate, TUpdate> {
  findFirst(where: TenantWhere): Promise<TRow | null>;
  findMany(query: { where: TenantWhere; orderBy: StableOrderBy; take: number }): Promise<TRow[]>;
  /** `data.clientId` é o do parâmetro do repositório; use só ele, nunca outra origem. */
  create(data: Omit<TCreate, 'clientId'> & { readonly clientId: ClientId }): Promise<TRow>;
  updateMany(where: TenantWhere, data: TUpdate): Promise<{ count: number }>;
  deleteMany(where: TenantWhere): Promise<{ count: number }>;
  count(where: TenantWhere): Promise<number>;
}

export interface TenantRepositoryParams<TRow extends PagedRow, T, TCreate, TUpdate> {
  readonly entity: string;
  readonly ops: TenantModelOps<TRow, TCreate, TUpdate>;
  readonly map: (row: TRow) => T;
}

/**
 * Base de repositório de tenant. É a primeira barreira de isolamento: o filtro por
 * cliente é montado **aqui** e nunca pelo chamador; só usa `findFirst`, `findMany`,
 * `create`, `updateMany`, `deleteMany` e `count`, sempre com `clientId` no `where`. Um id
 * de outro cliente se comporta como inexistente (`NotFoundError`). Use `forTransaction`
 * para operar dentro de `runInTransaction` com as mesmas garantias.
 */
export abstract class PrismaTenantRepository<
  TRow extends PagedRow,
  T,
  TCreate extends WithoutClientId,
  TUpdate extends WithoutClientId,
> implements TenantRepository<T, TCreate, TUpdate> {
  private readonly entity: string;
  private readonly ops: TenantModelOps<TRow, TCreate, TUpdate>;
  private readonly map: (row: TRow) => T;

  protected constructor(params: TenantRepositoryParams<TRow, T, TCreate, TUpdate>) {
    this.entity = params.entity;
    this.ops = params.ops;
    this.map = params.map;
  }

  /** O mesmo repositório sobre o client de uma transação (`runInTransaction`). */
  abstract forTransaction(tx: TenantScopedDb): TenantRepository<T, TCreate, TUpdate>;

  findById(clientId: ClientId, id: string): Promise<T> {
    return this.run('findById', async () => {
      const row = await this.findRow(clientId, id);
      return this.map(row);
    });
  }

  list(clientId: ClientId, options?: ListOptions): Promise<Page<T>> {
    return this.run('list', async () => {
      const { limit, take, after } = buildPageQuery(options);
      const rows = await this.ops.findMany({
        where: { clientId, ...(after === undefined ? {} : { OR: after }) },
        orderBy: stableOrderBy(),
        take,
      });
      return toPage(rows, limit, this.map);
    });
  }

  create(clientId: ClientId, data: TCreate): Promise<T> {
    return this.run('create', async () => {
      // O clientId vem DEPOIS do spread: um `clientId` em `data` (que o tipo proíbe, mas o
      // runtime não impede) nunca sobrescreve o do parâmetro.
      const row = await this.ops.create({ ...data, clientId });
      return this.map(row);
    });
  }

  update(clientId: ClientId, id: string, data: TUpdate): Promise<T> {
    return this.run('update', async () => {
      if (!isUuid(id)) throw this.notFound();
      const { count } = await this.ops.updateMany({ id, clientId }, data);
      if (count === 0) throw this.notFound();
      return this.map(await this.findRow(clientId, id));
    });
  }

  delete(clientId: ClientId, id: string): Promise<void> {
    return this.run('delete', async () => {
      if (!isUuid(id)) throw this.notFound();
      const { count } = await this.ops.deleteMany({ id, clientId });
      if (count === 0) throw this.notFound();
    });
  }

  count(clientId: ClientId): Promise<number> {
    return this.run('count', () => this.ops.count({ clientId }));
  }

  private async findRow(clientId: ClientId, id: string): Promise<TRow> {
    // Id malformado nunca existe: não vai ao banco (o cast para uuid falharia com erro 500).
    const row = isUuid(id) ? await this.ops.findFirst({ id, clientId }) : null;
    if (row === null) throw this.notFound();
    return row;
  }

  private notFound(): NotFoundError {
    return new NotFoundError('Recurso não encontrado', {
      context: { entity: this.entity },
    });
  }

  protected run<R>(operation: string, fn: () => Promise<R>): Promise<R> {
    return withRepositoryErrors(`${this.entity}.${operation}`, fn);
  }
}
