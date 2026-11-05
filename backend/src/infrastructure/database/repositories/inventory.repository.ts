import type { InventoryLedger } from '../../../application/ports/inventory-ledger.js';
import {
  type AdjustmentReason,
  type CompanyId,
  CompanyId as CompanyIdFactory,
  type ListOptions,
  type NewProduct,
  type Page,
  type Product,
  PRODUCT_QUANTITY_MAX,
  type ProductListOptions,
  type ProductRepository,
  type ProductUpdate,
  type StockMovement,
  type StockMovementRepository,
  type StockReason,
} from '../../../domain/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../../shared/errors/index.js';
import { isUuid } from '../../../shared/utils/index.js';
import type { TenantScopedDb, TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { runInTransaction } from '../transaction.js';
import { buildDescPageQuery, descOrderBy, resolveLimit, toPage } from './cursor.js';
import { withRepositoryErrors } from './repository-errors.js';

interface ProductRow {
  readonly id: string;
  readonly companyId: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly priceCents: number;
  readonly quantity: number;
  readonly lowStockThreshold: number;
  readonly active: boolean;
  readonly isSample: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface MovementRow {
  readonly id: string;
  readonly companyId: string;
  readonly productId: string;
  readonly delta: number;
  readonly quantityAfter: number;
  readonly reason: StockReason;
  readonly createdByMembershipId: string;
  readonly createdAt: Date;
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    companyId: CompanyIdFactory.parse(row.companyId),
    sku: row.sku,
    name: row.name,
    description: row.description,
    priceCents: row.priceCents,
    quantity: row.quantity,
    lowStockThreshold: row.lowStockThreshold,
    active: row.active,
    isSample: row.isSample,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMovement(row: MovementRow): StockMovement {
  return {
    id: row.id,
    companyId: CompanyIdFactory.parse(row.companyId),
    productId: row.productId,
    delta: row.delta,
    quantityAfter: row.quantityAfter,
    reason: row.reason,
    createdByMembershipId: row.createdByMembershipId,
    createdAt: row.createdAt,
  };
}

const notFound = (entity: string): NotFoundError =>
  new NotFoundError('Recurso não encontrado', { context: { entity } });

/** Cursor da lista de produtos: `[nome, id]` em base64url (a ordem é por nome e `id`). */
function encodeNameCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify([name, id])).toString('base64url');
}

function decodeNameCursor(cursor: string): { name: string; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('Cursor inválido');
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw new ValidationError('Cursor inválido');
  const [name, id] = parsed as readonly unknown[];
  if (typeof name !== 'string' || !isUuid(id)) throw new ValidationError('Cursor inválido');
  return { name, id: id.toLowerCase() };
}

/**
 * Produtos da empresa (spec 026, E2, model de tenant). `companyId` em todo `where`; **sem delete**:
 * produto não é apagado. A quantidade **não** é gravada por aqui (só pelo `PrismaInventoryLedger`).
 */
export class PrismaProductRepository implements ProductRepository {
  constructor(private readonly prisma: TenantScopedPrisma) {}

  private get db(): TenantScopedDb {
    return this.prisma;
  }

  list(companyId: CompanyId, options: ProductListOptions = {}): Promise<Page<Product>> {
    return withRepositoryErrors('Product.list', async () => {
      const limit = resolveLimit(options.limit);
      const cursor = options.cursor === undefined ? undefined : decodeNameCursor(options.cursor);
      const rows = await this.db.product.findMany({
        where: {
          companyId,
          ...(options.search === undefined ? {} : { searchText: { contains: options.search } }),
          ...(cursor === undefined
            ? {}
            : {
                OR: [{ name: { gt: cursor.name } }, { name: cursor.name, id: { gt: cursor.id } }],
              }),
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: limit + 1,
      });
      const pageRows = rows.slice(0, limit);
      const last = pageRows.at(-1);
      return {
        items: pageRows.map(toProduct),
        nextCursor:
          rows.length > limit && last !== undefined ? encodeNameCursor(last.name, last.id) : null,
      };
    });
  }

  findById(companyId: CompanyId, productId: string): Promise<Product> {
    return withRepositoryErrors('Product.findById', async () => {
      if (!isUuid(productId)) throw notFound('Product');
      const row = await this.db.product.findFirst({ where: { id: productId, companyId } });
      if (row === null) throw notFound('Product');
      return toProduct(row);
    });
  }

  update(companyId: CompanyId, productId: string, data: ProductUpdate): Promise<Product> {
    return withRepositoryErrors('Product.update', async () => {
      if (!isUuid(productId)) throw notFound('Product');
      // Nunca `quantity` nem `sku`: o tipo `ProductUpdate` não os tem.
      const { count } = await this.db.product.updateMany({
        where: { id: productId, companyId },
        data: {
          ...(data.name === undefined ? {} : { name: data.name }),
          ...(data.description === undefined ? {} : { description: data.description }),
          ...(data.priceCents === undefined ? {} : { priceCents: data.priceCents }),
          ...(data.lowStockThreshold === undefined
            ? {}
            : { lowStockThreshold: data.lowStockThreshold }),
          ...(data.active === undefined ? {} : { active: data.active }),
          ...(data.searchText === undefined ? {} : { searchText: data.searchText }),
        },
      });
      if (count === 0) throw notFound('Product');
      const row = await this.db.product.findFirst({ where: { id: productId, companyId } });
      if (row === null) throw notFound('Product');
      return toProduct(row);
    });
  }

  count(companyId: CompanyId): Promise<number> {
    return withRepositoryErrors('Product.count', () =>
      this.db.product.count({ where: { companyId } }),
    );
  }

  findExistingSkus(companyId: CompanyId, skus: readonly string[]): Promise<ReadonlySet<string>> {
    return withRepositoryErrors('Product.findExistingSkus', async () => {
      if (skus.length === 0) return new Set<string>();
      const rows = await this.db.product.findMany({
        where: { companyId, sku: { in: [...skus] } },
        select: { sku: true },
      });
      return new Set(rows.map((row) => row.sku));
    });
  }
}

/** Livro de movimentações (leitura). Imutável: sem `update` nem `delete`. */
export class PrismaStockMovementRepository implements StockMovementRepository {
  constructor(private readonly prisma: TenantScopedPrisma) {}

  listByProduct(
    companyId: CompanyId,
    productId: string,
    options?: ListOptions,
  ): Promise<Page<StockMovement>> {
    return withRepositoryErrors('StockMovement.list', async () => {
      if (!isUuid(productId)) throw notFound('Product');
      const owned = await this.prisma.product.findFirst({
        where: { id: productId, companyId },
        select: { id: true },
      });
      if (owned === null) throw notFound('Product');
      const { limit, take, after } = buildDescPageQuery(options);
      const rows = await this.prisma.stockMovement.findMany({
        where: { companyId, productId, ...(after === undefined ? {} : { OR: after }) },
        orderBy: descOrderBy(),
        take,
      });
      return toPage(rows, limit, toMovement);
    });
  }
}

/**
 * Escrita de estoque. O decremento/incremento é **atômico** e sem SQL cru: `updateManyAndReturn` com
 * a condição no `where` (`quantity >= -delta` para saída, `quantity <= MAX - delta` para entrada) e
 * `increment`. Zero linhas = nada gravado (409 ou 404). O movimento entra na **mesma** transação, com
 * `quantityAfter` lido da linha devolvida. O CHECK do banco (0 a 1.000.000) é a última barreira.
 */
export class PrismaInventoryLedger implements InventoryLedger {
  constructor(private readonly prisma: TenantScopedPrisma) {}

  createProduct(
    companyId: CompanyId,
    product: NewProduct,
    createdByMembershipId: string,
    reason: 'INITIAL' | 'IMPORT',
  ): Promise<Product> {
    return withRepositoryErrors('Inventory.createProduct', async () => {
      return runInTransaction(this.prisma, async (tx) => {
        const row = await tx.product.create({
          data: {
            companyId,
            sku: product.sku,
            name: product.name,
            description: product.description,
            priceCents: product.priceCents,
            quantity: product.quantity,
            lowStockThreshold: product.lowStockThreshold,
            isSample: product.isSample,
            searchText: product.searchText,
          },
        });
        if (product.quantity > 0) {
          await tx.stockMovement.create({
            data: {
              companyId,
              productId: row.id,
              delta: product.quantity,
              quantityAfter: row.quantity,
              reason,
              createdByMembershipId,
            },
          });
        }
        return toProduct(row);
      });
    }).catch((error: unknown) => {
      // `withRepositoryErrors` só traduz a unicidade em `ConflictError` genérico: aqui ele ganha o
      // código do SKU repetido, decidido pelo índice único do banco (também na corrida).
      if (error instanceof ConflictError && error.code === 'CONFLICT') {
        throw new ConflictError('SKU já existe nesta empresa', { code: 'SKU_IN_USE' });
      }
      throw error;
    });
  }

  adjust(
    companyId: CompanyId,
    productId: string,
    change: { readonly delta: number; readonly reason: AdjustmentReason },
    createdByMembershipId: string,
  ): Promise<{ readonly product: Product; readonly movement: StockMovement }> {
    return withRepositoryErrors('Inventory.adjust', async () => {
      if (!isUuid(productId)) throw notFound('Product');
      const { delta, reason } = change;
      return runInTransaction(this.prisma, async (tx) => {
        const rows = await tx.product.updateManyAndReturn({
          where: {
            id: productId,
            companyId,
            quantity: delta < 0 ? { gte: -delta } : { lte: PRODUCT_QUANTITY_MAX - delta },
          },
          data: { quantity: { increment: delta } },
        });
        const row = rows[0];
        if (row === undefined) {
          const exists = await tx.product.findFirst({
            where: { id: productId, companyId },
            select: { id: true },
          });
          if (exists === null) throw notFound('Product');
          throw delta < 0
            ? new ConflictError('Estoque insuficiente', { code: 'INSUFFICIENT_STOCK' })
            : new ConflictError('Quantidade acima do limite', { code: 'STOCK_LIMIT' });
        }
        const movement = await tx.stockMovement.create({
          data: {
            companyId,
            productId,
            delta,
            quantityAfter: row.quantity,
            reason,
            createdByMembershipId,
          },
        });
        return { product: toProduct(row), movement: toMovement(movement) };
      });
    });
  }
}
