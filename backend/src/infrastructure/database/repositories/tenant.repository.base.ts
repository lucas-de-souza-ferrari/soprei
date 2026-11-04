import type {
  CompanyId,
  ListOptions,
  Page,
  TenantRepository,
  WithoutCompanyId,
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

/** Filtro que a base monta: o `companyId` está sempre presente. */
export interface TenantWhere {
  readonly id?: string;
  readonly companyId: string;
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
  /** `data.companyId` é o do parâmetro do repositório; use só ele, nunca outra origem. */
  create(data: Omit<TCreate, 'companyId'> & { readonly companyId: CompanyId }): Promise<TRow>;
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
 * empresa é montado **aqui** e nunca pelo chamador; só usa `findFirst`, `findMany`,
 * `create`, `updateMany`, `deleteMany` e `count`, sempre com `companyId` no `where`. Um id
 * de outra empresa se comporta como inexistente (`NotFoundError`). Use `forTransaction`
 * para operar dentro de `runInTransaction` com as mesmas garantias.
 */
export abstract class PrismaTenantRepository<
  TRow extends PagedRow,
  T,
  TCreate extends WithoutCompanyId,
  TUpdate extends WithoutCompanyId,
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

  findById(companyId: CompanyId, id: string): Promise<T> {
    return this.run('findById', async () => {
      const row = await this.findRow(companyId, id);
      return this.map(row);
    });
  }

  list(companyId: CompanyId, options?: ListOptions): Promise<Page<T>> {
    return this.run('list', async () => {
      const { limit, take, after } = buildPageQuery(options);
      const rows = await this.ops.findMany({
        where: { companyId, ...(after === undefined ? {} : { OR: after }) },
        orderBy: stableOrderBy(),
        take,
      });
      return toPage(rows, limit, this.map);
    });
  }

  create(companyId: CompanyId, data: TCreate): Promise<T> {
    return this.run('create', async () => {
      // O companyId vem DEPOIS do spread: um `companyId` em `data` (que o tipo proíbe, mas o
      // runtime não impede) nunca sobrescreve o do parâmetro.
      const row = await this.ops.create({ ...data, companyId });
      return this.map(row);
    });
  }

  update(companyId: CompanyId, id: string, data: TUpdate): Promise<T> {
    return this.run('update', async () => {
      if (!isUuid(id)) throw this.notFound();
      const { count } = await this.ops.updateMany({ id, companyId }, data);
      if (count === 0) throw this.notFound();
      return this.map(await this.findRow(companyId, id));
    });
  }

  delete(companyId: CompanyId, id: string): Promise<void> {
    return this.run('delete', async () => {
      if (!isUuid(id)) throw this.notFound();
      const { count } = await this.ops.deleteMany({ id, companyId });
      if (count === 0) throw this.notFound();
    });
  }

  count(companyId: CompanyId): Promise<number> {
    return this.run('count', () => this.ops.count({ companyId }));
  }

  private async findRow(companyId: CompanyId, id: string): Promise<TRow> {
    // Id malformado nunca existe: não vai ao banco (o cast para uuid falharia com erro 500).
    const row = isUuid(id) ? await this.ops.findFirst({ id, companyId }) : null;
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
