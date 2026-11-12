import { z } from 'zod';
import { companyIdSchema } from './company.validators.js';

/** Itens por página da lista de notificações (spec 038). */
export const NOTIFICATIONS_DEFAULT_LIMIT = 30;
export const NOTIFICATIONS_MAX_LIMIT = 50;

/** `GET .../notifications`: `status` (`open` padrão, `resolved`, `all`), `limit` e `cursor`. */
export const notificationsQuerySchema = z
  .object({
    status: z.enum(['open', 'resolved', 'all']).optional(),
    limit: z.coerce.number().int().min(1).max(NOTIFICATIONS_MAX_LIMIT).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

/**
 * `:notificationId` malformado, inexistente e de outra empresa são o mesmo 404: a rota aceita qualquer
 * texto e o repositório decide, sem ecoar o valor.
 */
export const notificationParamsSchema = z.object({
  companyId: companyIdSchema,
  notificationId: z.string(),
});
