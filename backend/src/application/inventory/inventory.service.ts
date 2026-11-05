import {
  type CompanyId,
  INVENTORY_MAX_PRODUCTS,
  type ListOptions,
  type NewProduct,
  type Page,
  type Product,
  type ProductRepository,
  type ProductUpdate,
  type StockMovement,
  type StockMovementRepository,
} from '../../domain/index.js';
import { ConflictError } from '../../shared/errors/index.js';
import { buildSearchText, normalizeSearchText } from '../knowledge/normalize.js';
import type { InventoryLedger } from '../ports/inventory-ledger.js';
import {
  type Adjustment,
  importRowSchema,
  type ProductInput,
  type ProductPatch,
  searchSchema,
} from './inventory.schemas.js';

export const INVENTORY_LIMIT_REACHED = 'INVENTORY_LIMIT_REACHED';

/** Motivos fixos de uma linha ignorada na importação (sem eco do valor). */
export type ImportSkipReason = 'invalid' | 'duplicate_in_file' | 'sku_exists' | 'limit_reached';

export interface ImportResult {
  readonly created: number;
  readonly skipped: readonly { readonly row: number; readonly reason: ImportSkipReason }[];
}

export interface InventoryDeps {
  readonly products: ProductRepository;
  readonly movements: StockMovementRepository;
  readonly ledger: InventoryLedger;
}

function searchTextOf(sku: string, name: string, description: string): string {
  return buildSearchText(`${sku} ${name} ${description}`);
}

/**
 * Estoque da empresa (spec 026, E2). O `CompanyId` vem sempre da identidade autenticada. Nome, SKU,
 * descrição e preço nunca vão a log nem a métrica. A quantidade só muda por `adjust` (delta com
 * motivo fixo, atômico e com movimento no livro).
 */
export class InventoryService {
  constructor(private readonly deps: InventoryDeps) {}

  list(
    companyId: CompanyId,
    options: ListOptions & { readonly search?: string | undefined } = {},
  ): Promise<Page<Product>> {
    const { search, ...page } = options;
    const normalized =
      search === undefined ? '' : normalizeSearchText(searchSchema.parse(search)).trim();
    return this.deps.products.list(companyId, {
      ...page,
      ...(normalized === '' ? {} : { search: normalized }),
    });
  }

  async create(
    companyId: CompanyId,
    membershipId: string,
    input: ProductInput,
    options: { readonly isSample?: boolean; readonly reason?: 'INITIAL' | 'IMPORT' } = {},
  ): Promise<Product> {
    if ((await this.deps.products.count(companyId)) >= INVENTORY_MAX_PRODUCTS) {
      throw new ConflictError('Limite de produtos atingido', { code: INVENTORY_LIMIT_REACHED });
    }
    const description = input.description ?? '';
    const product: NewProduct = {
      sku: input.sku,
      name: input.name,
      description,
      priceCents: input.priceCents,
      quantity: input.quantity,
      lowStockThreshold: input.lowStockThreshold ?? 0,
      isSample: options.isSample ?? false,
      searchText: searchTextOf(input.sku, input.name, description),
    };
    return this.deps.ledger.createProduct(
      companyId,
      product,
      membershipId,
      options.reason ?? 'INITIAL',
    );
  }

  /** `NotFoundError` se o produto não é desta empresa. Nunca muda `quantity` nem `sku`. */
  async update(companyId: CompanyId, productId: string, patch: ProductPatch): Promise<Product> {
    const current = await this.deps.products.findById(companyId, productId);
    const name = patch.name ?? current.name;
    const description = patch.description ?? current.description;
    const data: ProductUpdate = {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.priceCents === undefined ? {} : { priceCents: patch.priceCents }),
      ...(patch.lowStockThreshold === undefined
        ? {}
        : { lowStockThreshold: patch.lowStockThreshold }),
      ...(patch.active === undefined ? {} : { active: patch.active }),
      ...(patch.name === undefined && patch.description === undefined
        ? {}
        : { searchText: searchTextOf(current.sku, name, description) }),
    };
    return this.deps.products.update(companyId, productId, data);
  }

  adjust(
    companyId: CompanyId,
    membershipId: string,
    productId: string,
    adjustment: Adjustment,
  ): Promise<{ readonly product: Product; readonly movement: StockMovement }> {
    return this.deps.ledger.adjust(companyId, productId, adjustment, membershipId);
  }

  async movements(
    companyId: CompanyId,
    productId: string,
    options?: ListOptions,
  ): Promise<Page<StockMovement>> {
    return this.deps.movements.listByProduct(companyId, productId, options);
  }

  /**
   * Importação (E4): só **cria**. SKU repetido na planilha ou já existente é ignorado com motivo fixo,
   * sem alterar o existente; linha inválida não derruba as demais. Cada produto criado grava `IMPORT`.
   */
  async importRows(
    companyId: CompanyId,
    membershipId: string,
    rows: readonly unknown[],
  ): Promise<ImportResult> {
    const skipped: { row: number; reason: ImportSkipReason }[] = [];
    const parsed: { row: number; input: ProductInput }[] = [];
    const seen = new Set<string>();
    rows.forEach((raw, index) => {
      const result = importRowSchema.safeParse(raw);
      if (!result.success) {
        skipped.push({ row: index + 1, reason: 'invalid' });
      } else if (seen.has(result.data.sku)) {
        skipped.push({ row: index + 1, reason: 'duplicate_in_file' });
      } else {
        seen.add(result.data.sku);
        parsed.push({ row: index + 1, input: { ...result.data } });
      }
    });
    const existing = await this.deps.products.findExistingSkus(
      companyId,
      parsed.map((entry) => entry.input.sku),
    );
    let created = 0;
    for (const { row, input } of parsed) {
      if (existing.has(input.sku)) {
        skipped.push({ row, reason: 'sku_exists' });
        continue;
      }
      try {
        await this.create(companyId, membershipId, input, { reason: 'IMPORT' });
        created += 1;
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        skipped.push({
          row,
          reason: error.code === INVENTORY_LIMIT_REACHED ? 'limit_reached' : 'sku_exists',
        });
      }
    }
    skipped.sort((left, right) => left.row - right.row);
    return { created, skipped };
  }
}
