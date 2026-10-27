import type { FastifyPluginCallback } from 'fastify';
import type { AttendanceService } from '../../application/attendance/attendance.service.js';
import type { Conversation, ListOptions, Message } from '../../domain/index.js';
import { setClientId } from '../../shared/request-context/index.js';
import { rateLimitProfile } from '../rate-limit.js';
import { adminAuthHook } from './admin-auth.hook.js';
import {
  clientScopeParamsSchema,
  conversationParamsSchema,
  inboundMessageBodySchema,
  listQuerySchema,
} from './attendance.validators.js';

export interface AdminAttendanceControllerOptions {
  /** `ADMIN_API_KEY`; ausente significa que toda requisição a /admin recebe 401. */
  readonly apiKey: string | undefined;
  readonly attendance: AttendanceService;
}

function toConversationResponse(conversation: Conversation): {
  id: string;
  contactRef: string;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: conversation.id,
    contactRef: conversation.contactRef,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

function toMessageResponse(message: Message): {
  id: string;
  role: string;
  content: string;
  isFallback: boolean;
  externalId: string | null;
  replyToId: string | null;
  createdAt: string;
} {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    isFallback: message.isFallback,
    externalId: message.externalId,
    replyToId: message.replyToId,
    createdAt: message.createdAt.toISOString(),
  };
}

function toListOptions(query: {
  limit?: number | undefined;
  cursor?: string | undefined;
}): ListOptions {
  return {
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
}

/**
 * Simulador do canal e consulta de conversas (spec 010), sob `ADMIN_API_KEY`. Registre com
 * `prefix: '/admin/clients'`. Rotas finas: validam com Zod, preenchem o `clientId` do contexto
 * de log (vem do path validado, nunca de corpo ou cabeçalho), chamam o service e deixam o erro
 * subir ao handler central. O conteúdo das mensagens só trafega na resposta; nunca vai a log.
 */
export const adminAttendanceController: FastifyPluginCallback<AdminAttendanceControllerOptions> = (
  app,
  { apiKey, attendance },
  done,
) => {
  app.addHook('onRequest', adminAuthHook(apiKey));
  // Rate limit por perfil (spec 005): todas as rotas daqui são `admin`.
  const config = rateLimitProfile('admin');

  app.post('/:clientId/messages', { config }, async (request, reply) => {
    const { clientId } = clientScopeParamsSchema.parse(request.params);
    setClientId(clientId);
    const body = inboundMessageBodySchema.parse(request.body);
    const result = await attendance.handleInboundMessage(clientId, body);
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });

  app.get('/:clientId/conversations', { config }, async (request) => {
    const { clientId } = clientScopeParamsSchema.parse(request.params);
    setClientId(clientId);
    const query = listQuerySchema.parse(request.query);
    const page = await attendance.listConversations(clientId, toListOptions(query));
    return { items: page.items.map(toConversationResponse), nextCursor: page.nextCursor };
  });

  app.get('/:clientId/conversations/:conversationId/messages', { config }, async (request) => {
    const { clientId, conversationId } = conversationParamsSchema.parse(request.params);
    setClientId(clientId);
    const query = listQuerySchema.parse(request.query);
    const page = await attendance.listMessages(clientId, conversationId, toListOptions(query));
    return { items: page.items.map(toMessageResponse), nextCursor: page.nextCursor };
  });

  done();
};
