import type {
  AdjustmentReason,
  CompanyId,
  NewProduct,
  Product,
  StockMovement,
} from '../../domain/index.js';

/**
 * Escrita de estoque (spec 026, E2). Cada operação é **uma transação**: produto e movimento
 * confirmam ou desfazem juntos. A quantidade só muda por aqui e sempre por `delta`, de forma
 * atômica (nunca negativa); o movimento é gravado na mesma transação.
 */
export interface InventoryLedger {
  /**
   * Cria o produto e, se `quantity > 0`, o movimento inicial (`INITIAL` ou `IMPORT`). SKU repetido
   * na empresa é `ConflictError` com `code` `SKU_IN_USE` (decidido pelo índice único do banco).
   */
  createProduct(
    companyId: CompanyId,
    product: NewProduct,
    createdByMembershipId: string,
    reason: 'INITIAL' | 'IMPORT',
  ): Promise<Product>;

  /**
   * Aplica `delta` à quantidade. Zero linhas atingidas: `NotFoundError` (produto de outra empresa ou
   * inexistente) ou `ConflictError` `INSUFFICIENT_STOCK` (saída maior que o estoque) / `STOCK_LIMIT`
   * (entrada acima do teto), **sem** gravar movimento.
   */
  adjust(
    companyId: CompanyId,
    productId: string,
    change: { readonly delta: number; readonly reason: AdjustmentReason },
    createdByMembershipId: string,
  ): Promise<{ readonly product: Product; readonly movement: StockMovement }>;
}
