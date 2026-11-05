import { z } from 'zod';
import { ApiError, request } from '../api';

/**
 * Estoque da empresa (spec 026, E2): contratos estritos e mensagens por `status` e `error.code`. O
 * texto de erro do servidor nunca é lido nem exibido. SKU, nome, descrição e preço vivem só em
 * memória: nada vai a URL, armazenamento do navegador, título da página nem log.
 */
export const INVENTORY_PAGE_SIZE = 50;
export const MOVEMENTS_PAGE_SIZE = 30;

const isoDate = z.iso.datetime();
const cursorText = z.string().min(1).max(512);

export const productSchema = z.strictObject({
  id: z.uuid(),
  sku: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  description: z.string().max(500),
  priceCents: z.number().int().min(0),
  quantity: z.number().int().min(0),
  lowStockThreshold: z.number().int().min(0),
  active: z.boolean(),
  isSample: z.boolean(),
  updatedAt: isoDate,
});
export type Product = z.infer<typeof productSchema>;

export const productsPageSchema = z.strictObject({
  items: z.array(productSchema).max(200),
  nextCursor: cursorText.nullable(),
});

export const STOCK_REASONS = [
  'INITIAL',
  'ENTRY',
  'EXIT',
  'LOSS',
  'COUNT_CORRECTION',
  'IMPORT',
] as const;
export type StockReason = (typeof STOCK_REASONS)[number];

export const movementSchema = z.strictObject({
  id: z.uuid(),
  delta: z.number().int(),
  quantityAfter: z.number().int().min(0),
  reason: z.enum(STOCK_REASONS),
  createdAt: isoDate,
  byMe: z.boolean(),
});
export type Movement = z.infer<typeof movementSchema>;

export const movementsPageSchema = z.strictObject({
  items: z.array(movementSchema).max(200),
  nextCursor: cursorText.nullable(),
});

export const adjustmentResultSchema = z.strictObject({
  product: productSchema,
  movement: movementSchema,
});

export const importResultSchema = z.strictObject({
  created: z.number().int().min(0),
  skipped: z
    .array(
      z.strictObject({
        row: z.number().int().min(1),
        reason: z.enum(['invalid', 'duplicate_in_file', 'sku_exists', 'limit_reached']),
      }),
    )
    .max(200),
});
export type ImportResult = z.infer<typeof importResultSchema>;

export interface ProductInput {
  readonly sku: string;
  readonly name: string;
  readonly description?: string;
  readonly priceCents: number;
  readonly quantity: number;
  readonly lowStockThreshold?: number;
}

export interface ProductPatch {
  readonly name?: string;
  readonly description?: string;
  readonly priceCents?: number;
  readonly lowStockThreshold?: number;
  readonly active?: boolean;
}

const companyPath = (companyId: string): string =>
  `/admin/companies/${companyId}/inventory/products`;
const part = (id: string): string => encodeURIComponent(id);

function queryOf(params: Readonly<Record<string, string | number | undefined>>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

export const inventoryApi = {
  products: async (companyId: string, params: { q?: string; cursor?: string } = {}) =>
    productsPageSchema.parse(
      await request(
        `${companyPath(companyId)}${queryOf({ limit: INVENTORY_PAGE_SIZE, q: params.q, cursor: params.cursor })}`,
      ),
    ),
  create: async (companyId: string, body: ProductInput) =>
    productSchema.parse(await request(companyPath(companyId), { method: 'POST', body })),
  update: async (companyId: string, productId: string, body: ProductPatch) =>
    productSchema.parse(
      await request(`${companyPath(companyId)}/${part(productId)}`, { method: 'PATCH', body }),
    ),
  adjust: async (
    companyId: string,
    productId: string,
    body: { delta: number; reason: 'ENTRY' | 'EXIT' | 'LOSS' | 'COUNT_CORRECTION' },
  ) =>
    adjustmentResultSchema.parse(
      await request(`${companyPath(companyId)}/${part(productId)}/adjustments`, {
        method: 'POST',
        body,
      }),
    ),
  movements: async (companyId: string, productId: string, cursor?: string) =>
    movementsPageSchema.parse(
      await request(
        `${companyPath(companyId)}/${part(productId)}/movements${queryOf({ limit: MOVEMENTS_PAGE_SIZE, cursor })}`,
      ),
    ),
  importRows: async (
    companyId: string,
    rows: readonly {
      sku: string;
      name: string;
      description?: string;
      priceCents: number;
      quantity: number;
    }[],
  ) =>
    importResultSchema.parse(
      await request(`${companyPath(companyId)}/import`, { method: 'POST', body: { rows } }),
    ),
};

export const SKU_IN_USE_MESSAGE = 'Já existe um produto com este SKU nesta empresa.';
export const INSUFFICIENT_STOCK_MESSAGE = 'Estoque insuficiente para esta saída.';
export const STOCK_LIMIT_MESSAGE = 'A quantidade passaria do limite de 1.000.000 de unidades.';
export const INVENTORY_LIMIT_MESSAGE = 'Limite de 500 produtos atingido.';
export const INVENTORY_INVALID_MESSAGE =
  'Confira os campos: SKU (letras, números, ponto, hífen e sublinhado), nome e valores.';
export const INVENTORY_STALE_MESSAGE = 'Este produto não existe mais. A lista foi atualizada.';

const CODE_MESSAGES: Readonly<Record<string, string>> = {
  SKU_IN_USE: SKU_IN_USE_MESSAGE,
  INSUFFICIENT_STOCK: INSUFFICIENT_STOCK_MESSAGE,
  STOCK_LIMIT: STOCK_LIMIT_MESSAGE,
  INVENTORY_LIMIT_REACHED: INVENTORY_LIMIT_MESSAGE,
};

/**
 * Mensagem própria do estoque para uma falha, ou `null` quando ela é de outro tipo (sessão, empresa
 * trocada, permissão, indisponível), que a área da empresa trata em `settle`.
 */
export function inventoryMessageOf(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const known = error.code === undefined ? undefined : CODE_MESSAGES[error.code];
  if (known !== undefined) return known;
  if (error.status === 400) return INVENTORY_INVALID_MESSAGE;
  return null;
}
