import { z } from 'zod';
import {
  ADJUSTMENT_REASONS,
  INVENTORY_IMPORT_MAX_ROWS,
  INVENTORY_SEARCH_MAX_LENGTH,
  PRODUCT_DESCRIPTION_MAX_LENGTH,
  PRODUCT_NAME_MAX_LENGTH,
  PRODUCT_PRICE_MAX_CENTS,
  PRODUCT_QUANTITY_MAX,
  PRODUCT_SKU_PATTERN,
  PRODUCT_THRESHOLD_MAX,
  STOCK_ADJUSTMENT_MAX,
} from '../../domain/index.js';

const NUL = String.fromCharCode(0);
const noNul = (value: string): boolean => !value.includes(NUL);

/** SKU em maiúsculas (normalizado antes de validar): `^[A-Z0-9._-]{1,40}$`. */
export const skuSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => PRODUCT_SKU_PATTERN.test(value), 'SKU inválido');

const nameSchema = z.string().trim().min(1).max(PRODUCT_NAME_MAX_LENGTH).refine(noNul);
const descriptionSchema = z.string().trim().max(PRODUCT_DESCRIPTION_MAX_LENGTH).refine(noNul);
const priceSchema = z.number().int().min(0).max(PRODUCT_PRICE_MAX_CENTS);
const quantitySchema = z.number().int().min(0).max(PRODUCT_QUANTITY_MAX);
const thresholdSchema = z.number().int().min(0).max(PRODUCT_THRESHOLD_MAX);

/** Corpo de `POST .../inventory/products` e de cada linha da importação. */
export const productInputSchema = z
  .object({
    sku: skuSchema,
    name: nameSchema,
    description: descriptionSchema.optional(),
    priceCents: priceSchema,
    quantity: quantitySchema,
    lowStockThreshold: thresholdSchema.optional(),
  })
  .strict();
export type ProductInput = z.infer<typeof productInputSchema>;

/** Linha da importação: sem alerta de estoque baixo (a planilha tem só as cinco colunas). */
export const importRowSchema = z
  .object({
    sku: skuSchema,
    name: nameSchema,
    description: descriptionSchema.optional(),
    priceCents: priceSchema,
    quantity: quantitySchema,
  })
  .strict();

/** Corpo de `PATCH`: ao menos um campo; **nunca** `quantity` nem `sku`. */
export const productPatchSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    priceCents: priceSchema.optional(),
    lowStockThreshold: thresholdSchema.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'informe ao menos um campo',
  });
export type ProductPatch = z.infer<typeof productPatchSchema>;

/** Corpo de `POST .../adjustments`: `delta` inteiro não zero. */
export const adjustmentSchema = z
  .object({
    delta: z
      .number()
      .int()
      .min(-STOCK_ADJUSTMENT_MAX)
      .max(STOCK_ADJUSTMENT_MAX)
      .refine((value) => value !== 0, 'delta não pode ser zero'),
    reason: z.enum(ADJUSTMENT_REASONS),
  })
  .strict();
export type Adjustment = z.infer<typeof adjustmentSchema>;

export const searchSchema = z.string().trim().max(INVENTORY_SEARCH_MAX_LENGTH).refine(noNul);

/** Corpo de `POST .../import`: de 1 a 200 linhas; cada linha é validada à parte. */
export const importBodySchema = z
  .object({ rows: z.array(z.unknown()).min(1).max(INVENTORY_IMPORT_MAX_ROWS) })
  .strict();
