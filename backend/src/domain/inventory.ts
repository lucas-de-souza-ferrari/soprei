import type { ListOptions, Page } from './pagination.js';
import type { CompanyId } from './value-objects/company-id.js';

/**
 * Controle de estoque (spec 026, E2): catálogo simples por empresa e livro de movimentações
 * imutável. Limites são constantes nomeadas (sem variável de ambiente).
 */
export const PRODUCT_SKU_PATTERN = /^[A-Z0-9._-]{1,40}$/;
export const PRODUCT_NAME_MAX_LENGTH = 120;
export const PRODUCT_DESCRIPTION_MAX_LENGTH = 500;
export const PRODUCT_PRICE_MAX_CENTS = 100_000_000;
export const PRODUCT_QUANTITY_MAX = 1_000_000;
export const PRODUCT_THRESHOLD_MAX = 1_000_000;
/** Produtos por empresa (de melhor esforço sob concorrência). */
export const INVENTORY_MAX_PRODUCTS = 500;
/** Tamanho máximo de um ajuste (valor absoluto do `delta`). */
export const STOCK_ADJUSTMENT_MAX = 100_000;
export const INVENTORY_IMPORT_MAX_ROWS = 200;
export const INVENTORY_SEARCH_MAX_LENGTH = 60;

/** Motivos do livro de movimentações (enum fixo: sem texto livre). */
export const STOCK_REASONS = [
  'INITIAL',
  'ENTRY',
  'EXIT',
  'LOSS',
  'COUNT_CORRECTION',
  'IMPORT',
] as const;
export type StockReason = (typeof STOCK_REASONS)[number];

/** Motivos que a API de ajuste aceita (os demais são gravados só pelo sistema). */
export const ADJUSTMENT_REASONS = ['ENTRY', 'EXIT', 'LOSS', 'COUNT_CORRECTION'] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export interface Product {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly priceCents: number;
  readonly quantity: number;
  readonly lowStockThreshold: number;
  readonly active: boolean;
  readonly isSample: boolean;
  readonly createdAt: Date;
  /** "A hora do dado" que vai ao prompt. */
  readonly updatedAt: Date;
}

export interface NewProduct {
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly priceCents: number;
  readonly quantity: number;
  readonly lowStockThreshold: number;
  readonly isSample: boolean;
  /** Texto de busca já normalizado (com e sem acentos). */
  readonly searchText: string;
}

/** O que o `PATCH` muda: nunca `quantity` nem `sku`. */
export interface ProductUpdate {
  readonly name?: string;
  readonly description?: string;
  readonly priceCents?: number;
  readonly lowStockThreshold?: number;
  readonly active?: boolean;
  readonly searchText?: string;
}

export interface StockMovement {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly productId: string;
  readonly delta: number;
  readonly quantityAfter: number;
  readonly reason: StockReason;
  readonly createdByMembershipId: string;
  readonly createdAt: Date;
}

export interface NewStockMovement {
  readonly productId: string;
  readonly delta: number;
  readonly quantityAfter: number;
  readonly reason: StockReason;
  readonly createdByMembershipId: string;
}

export interface ProductListOptions extends ListOptions {
  /** Filtro "contém" em nome ou SKU, já normalizado (minúsculo e sem acento). */
  readonly search?: string;
}

/**
 * Produtos de uma empresa. `CompanyId` é o primeiro parâmetro de todo método. **Sem `delete`**:
 * produto não é apagado (o livro de movimentos o impede); "remover" é `active: false`.
 */
export interface ProductRepository {
  /** Ordem por nome e `id`; o cursor leva os dois. */
  list(companyId: CompanyId, options?: ProductListOptions): Promise<Page<Product>>;
  findById(companyId: CompanyId, productId: string): Promise<Product>;
  update(companyId: CompanyId, productId: string, data: ProductUpdate): Promise<Product>;
  count(companyId: CompanyId): Promise<number>;
  /** Os produtos de exemplo (ativos ou não) da empresa (spec 026, E3). */
  listSamples(companyId: CompanyId): Promise<Product[]>;
  /** SKUs que já existem na empresa, entre os pedidos (importação). */
  findExistingSkus(companyId: CompanyId, skus: readonly string[]): Promise<ReadonlySet<string>>;
}

/** Livro de movimentações de uma empresa: só `list` aqui (a escrita é do `InventoryUnitOfWork`). */
export interface StockMovementRepository {
  /** Mais recentes primeiro. `NotFoundError` se o produto não é desta empresa. */
  listByProduct(
    companyId: CompanyId,
    productId: string,
    options?: ListOptions,
  ): Promise<Page<StockMovement>>;
}
