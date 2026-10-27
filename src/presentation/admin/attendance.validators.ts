import { z } from 'zod';
import { isUuid } from '../../shared/utils/index.js';
import { inboundMessageSchema } from '../../application/attendance/attendance.schemas.js';
import { clientIdSchema, listClientsQuerySchema } from './client.validators.js';

/** `:clientId` vira `ClientId`; inválido é 400. */
export const clientScopeParamsSchema = z.object({ clientId: clientIdSchema });

/** `:conversationId` precisa ser um UUID; inválido é 400 (de outro cliente: 404, no service). */
export const conversationParamsSchema = z.object({
  clientId: clientIdSchema,
  conversationId: z.string().refine(isUuid, 'deve ser um UUID válido'),
});

/** Corpo de `POST /admin/clients/:clientId/messages`. */
export const inboundMessageBodySchema = inboundMessageSchema;

/** `limit` e `cursor` das listagens (mesmas regras da listagem de clientes). */
export const listQuerySchema = listClientsQuerySchema;
