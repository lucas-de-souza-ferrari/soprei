import type { FastifyPluginCallback } from 'fastify';
import type { AttendanceService } from '../../application/attendance/attendance.service.js';
import type { Conversation, ListOptions, Message } from '../../domain/index.js';
import type { AuthService } from '../../application/auth/auth.service.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { authenticateHook, requireUser, userAuth } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import {
  conversationParamsSchema,
  inboundMessageBodySchema,
  listQuerySchema,
} from './attendance.validators.js';

export interface AdminAttendanceControllerOptions {
  /** Verificação do access token (spec 007). */
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?: Pick<Metrics, 'countAuthTokenRejection'> | undefined;
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
  /** Quando a resposta foi entregue ao canal (ISO); nulo = ainda não enviada (ou o envio falhou). */
  sentAt: string | null;
} {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    isFallback: message.isFallback,
    externalId: message.externalId,
    replyToId: message.replyToId,
    createdAt: message.createdAt.toISOString(),
    sentAt: message.sentAt === null ? null : message.sentAt.toISOString(),
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
 * Simulador do canal e consulta de conversas (spec 010), só para `User` (spec 007). Registre com
 * `prefix: '/admin/clients'`. O `:clientId` do caminho é **conferido** contra o do token assinado
 * (`requireUser({ clientParam })`: divergência é 404, igual a cliente inexistente) e descartado; o
 * service sempre recebe o `clientId` do token. Rotas finas: validam com Zod, chamam o service e
 * deixam o erro subir ao handler central. O conteúdo das mensagens só trafega na resposta; nunca
 * vai a log.
 */
export const adminAttendanceController: FastifyPluginCallback<AdminAttendanceControllerOptions> = (
  app,
  { auth, metrics, attendance },
  done,
) => {
  app.addHook('onRequest', authenticateHook({ auth, metrics }));
  // Rate limit por perfil (spec 005): todas as rotas daqui são `admin`.
  const config = rateLimitProfile('admin');
  const onRequest = requireUser({ clientParam: 'clientId' });

  app.post('/:clientId/messages', { config, onRequest }, async (request, reply) => {
    const { clientId } = userAuth(request);
    const body = inboundMessageBodySchema.parse(request.body);
    const result = await attendance.handleInboundMessage(clientId, body);
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });

  app.get('/:clientId/conversations', { config, onRequest }, async (request) => {
    const { clientId } = userAuth(request);
    const query = listQuerySchema.parse(request.query);
    const page = await attendance.listConversations(clientId, toListOptions(query));
    return { items: page.items.map(toConversationResponse), nextCursor: page.nextCursor };
  });

  app.get(
    '/:clientId/conversations/:conversationId/messages',
    { config, onRequest },
    async (request) => {
      const { conversationId } = conversationParamsSchema.parse(request.params);
      const { clientId } = userAuth(request);
      const query = listQuerySchema.parse(request.query);
      const page = await attendance.listMessages(clientId, conversationId, toListOptions(query));
      return { items: page.items.map(toMessageResponse), nextCursor: page.nextCursor };
    },
  );

  done();
};
