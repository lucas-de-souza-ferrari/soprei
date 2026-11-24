import { z } from 'zod';
import {
  PLATFORM_ATTENTION_FILTERS,
  PLATFORM_LIST_DEFAULT_LIMIT,
  PLATFORM_LIST_MAX_LIMIT,
} from '../../application/ports/platform-read-model.js';
import {
  BILLING_NOTICE_KINDS,
  PAYMENT_ORDER_KINDS,
  PAYMENT_ORDER_STATUSES,
  PLATFORM_ACTION_REASONS,
} from '../../domain/index.js';

/** Valores das consultas em minúsculas (como `status=active`); as respostas trazem os enums em maiúsculas. */
function lowerEnum<const T extends readonly [string, ...string[]]>(values: T) {
  const lower = values.map((value) => value.toLowerCase()) as [string, ...string[]];
  return z.enum(lower).transform((value) => value.toUpperCase() as T[number]);
}

const pageShape = {
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PLATFORM_LIST_MAX_LIMIT)
    .default(PLATFORM_LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(512).optional(),
};

export const platformCompaniesQuerySchema = z
  .object({
    ...pageShape,
    status: z.enum(['active', 'suspended']).optional(),
    q: z.string().trim().max(64).optional(),
    attention: z.enum(PLATFORM_ATTENTION_FILTERS).optional(),
  })
  .strict();

export const platformAccountsQuerySchema = z
  .object({
    ...pageShape,
    status: z.enum(['active', 'disabled']).optional(),
    verified: z.enum(['true', 'false']).optional(),
  })
  .strict();

export const platformOrdersQuerySchema = z
  .object({
    ...pageShape,
    status: lowerEnum(PAYMENT_ORDER_STATUSES).optional(),
    kind: lowerEnum(PAYMENT_ORDER_KINDS).optional(),
  })
  .strict();

export const platformNoticesQuerySchema = z
  .object({ ...pageShape, kind: lowerEnum(BILLING_NOTICE_KINDS).optional() })
  .strict();

/** O id do caminho vai cru ao serviço: malformado, inexistente ou removido são o mesmo 404. */
export const platformCompanyParamsSchema = z.object({ companyId: z.string() });
export const platformAccountParamsSchema = z.object({ accountId: z.string() });

/** Corpo de suspender e reativar (D1): só o motivo, de uma lista fixa (nunca texto livre). */
export const platformActionBodySchema = z
  .object({ reason: z.enum(PLATFORM_ACTION_REASONS) })
  .strict();
