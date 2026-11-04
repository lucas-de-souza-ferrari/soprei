import { z } from 'zod';
import { isUuid } from '../../shared/utils/index.js';
import { inboundMessageSchema } from '../../application/attendance/attendance.schemas.js';
import { companyIdSchema, listCompaniesQuerySchema } from './company.validators.js';

/** `:conversationId` precisa ser um UUID; inválido é 400 (de outra empresa: 404, no service). */
export const conversationParamsSchema = z.object({
  companyId: companyIdSchema,
  conversationId: z.string().refine(isUuid, 'deve ser um UUID válido'),
});

/** Corpo de `POST /admin/companies/:companyId/messages`. */
export const inboundMessageBodySchema = inboundMessageSchema;

/** `limit` e `cursor` das listagens (mesmas regras da listagem de empresas). */
export const listQuerySchema = listCompaniesQuerySchema;
