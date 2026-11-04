import { z } from 'zod';
import { inboundMessageSchema } from '../../application/attendance/attendance.schemas.js';
import { companyIdSchema, listCompaniesQuerySchema } from './company.validators.js';

/**
 * `:conversationId` malformado, inexistente e de outra empresa são o mesmo 404 (spec 024, como
 * `:membershipId` na 008): a rota aceita qualquer texto e o repositório decide, sem ecoar o valor.
 */
export const conversationParamsSchema = z.object({
  companyId: companyIdSchema,
  conversationId: z.string().max(256),
});

/** Corpo de `POST /admin/companies/:companyId/messages`. */
export const inboundMessageBodySchema = inboundMessageSchema;

/** `limit` e `cursor` das listagens (mesmas regras da listagem de empresas). */
export const listQuerySchema = listCompaniesQuerySchema;

/** Query do histórico: `limit`, `cursor` e `order` (`asc` padrão, `desc`; valor desconhecido é 400). */
export const messagesQuerySchema = listCompaniesQuerySchema.extend({
  order: z.enum(['asc', 'desc']).optional(),
});
