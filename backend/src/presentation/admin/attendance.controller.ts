import type { FastifyPluginCallback, onRequestAsyncHookHandler } from 'fastify';
import type { AttendanceService } from '../../application/attendance/attendance.service.js';
import type { Conversation, Message, Permission } from '../../domain/index.js';
import type { AuthService } from '../../application/auth/auth.service.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { authenticateHook, requirePermission, membershipAuth } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import { toListOptions } from './list-options.js';
import {
  conversationParamsSchema,
  inboundMessageBodySchema,
  listQuerySchema,
} from './attendance.validators.js';

export interface AdminAttendanceControllerOptions {
  /** Verificação do access token (spec 007). */
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?: Pick<Metrics, 'countAuthTokenRejection' | 'countAuthzDenial'> | undefined;
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

/**
 * Simulador do canal e consulta de conversas (spec 010), só para `Membership` (spec 007). Registre com
 * `prefix: '/admin/companies'`. O `:companyId` do caminho é **conferido** contra o do token assinado
 * (`requireMembership({ companyParam })`: divergência é 404, igual a empresa inexistente) e descartado; o
 * service sempre recebe o `companyId` do token. Rotas finas: validam com Zod, chamam o service e
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
  // Permissão explícita em toda rota de tenant (spec 008); o `:companyId` é conferido contra o token.
  const guard = (permission: Permission): onRequestAsyncHookHandler =>
    requirePermission(permission, { companyParam: 'companyId', metrics });

  app.post(
    '/:companyId/messages',
    { config, onRequest: guard('conversation:simulate') },
    async (request, reply) => {
      const { companyId } = membershipAuth(request);
      const body = inboundMessageBodySchema.parse(request.body);
      const result = await attendance.handleInboundMessage(companyId, body);
      return reply.status(result.duplicate ? 200 : 201).send(result);
    },
  );

  app.get(
    '/:companyId/conversations',
    { config, onRequest: guard('conversation:read') },
    async (request) => {
      const { companyId } = membershipAuth(request);
      const query = listQuerySchema.parse(request.query);
      const page = await attendance.listConversations(companyId, toListOptions(query));
      return { items: page.items.map(toConversationResponse), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/:companyId/conversations/:conversationId/messages',
    { config, onRequest: guard('conversation:read') },
    async (request) => {
      const { conversationId } = conversationParamsSchema.parse(request.params);
      const { companyId } = membershipAuth(request);
      const query = listQuerySchema.parse(request.query);
      const page = await attendance.listMessages(companyId, conversationId, toListOptions(query));
      return { items: page.items.map(toMessageResponse), nextCursor: page.nextCursor };
    },
  );

  done();
};
