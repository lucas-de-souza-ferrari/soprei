import type { FastifyPluginCallback, onRequestAsyncHookHandler } from 'fastify';
import { describeContact } from '../../application/attendance/contact-label.js';
import type { AttendanceService } from '../../application/attendance/attendance.service.js';
import type { Conversation, Message, OpenHandoff, Permission } from '../../domain/index.js';
import type { NotificationService } from '../../application/notifications/notification.service.js';
import type { AuthService } from '../../application/auth/auth.service.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { authenticateHook, requirePermission, membershipAuth } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import { toListOptions } from './list-options.js';
import {
  conversationParamsSchema,
  inboundMessageBodySchema,
  listQuerySchema,
  messagesQuerySchema,
} from './attendance.validators.js';

export interface AdminAttendanceControllerOptions {
  /** Verificação do access token (spec 007). */
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?: Pick<Metrics, 'countAuthTokenRejection' | 'countAuthzDenial'> | undefined;
  readonly attendance: AttendanceService;
  /** Spec 038: sem isto as conversas saem sem `openHandoff` (como antes). */
  readonly notifications?: Pick<NotificationService, 'openHandoffs'> | undefined;
}

/** Pedido de atendimento humano aberto na conversa (spec 038); só id, motivo e quando. */
function toOpenHandoffResponse(
  handoff: OpenHandoff | undefined,
): { notificationId: string; reason: string | null; createdAt: string } | null {
  if (handoff === undefined) return null;
  return {
    notificationId: handoff.notificationId,
    reason: handoff.reason,
    createdAt: handoff.createdAt.toISOString(),
  };
}

/**
 * Conversa para o navegador (spec 024): o `contactRef` (o telefone do contato no WhatsApp) **nunca**
 * sai por aqui; vai só o rótulo mascarado no servidor e o canal. `updatedAt` é a última atividade.
 */
function toConversationResponse(
  conversation: Conversation,
  /** Spec 039: a pausa ainda vigente (`AttendanceService.activePause`), ou `null`. */
  pausedUntil: Date | null,
): {
  id: string;
  contactLabel: string;
  channel: string;
  createdAt: string;
  updatedAt: string;
  /** Spec 039: até quando a IA está pausada (ISO); `null` se não está (ou se a pausa já passou). */
  aiPausedUntil: string | null;
} {
  const { contactLabel, channel } = describeContact(
    conversation.companyId,
    conversation.contactRef,
  );
  return {
    id: conversation.id,
    contactLabel,
    channel,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    aiPausedUntil: pausedUntil?.toISOString() ?? null,
  };
}

/**
 * Mensagem para o navegador. O `externalId` (o `wamid` do canal, que carrega o telefone em base64)
 * não sai (spec 024).
 */
function toMessageResponse(message: Message): {
  id: string;
  role: string;
  content: string;
  isFallback: boolean;
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
  { auth, metrics, attendance, notifications },
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
      const items = page.items.map((item) =>
        toConversationResponse(item, attendance.activePause(item)),
      );
      if (notifications === undefined) return { items, nextCursor: page.nextCursor };
      // Spec 038: selo "Humano" na lista (uma consulta em lote, sem N+1).
      const open = await notifications.openHandoffs(
        companyId,
        items.map((item) => item.id),
      );
      return {
        items: items.map((item) => ({ ...item, openHandoff: open.has(item.id) })),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.get(
    '/:companyId/conversations/:conversationId/messages',
    { config, onRequest: guard('conversation:read') },
    async (request) => {
      const { conversationId } = conversationParamsSchema.parse(request.params);
      const { companyId } = membershipAuth(request);
      const query = messagesQuerySchema.parse(request.query);
      const page = await attendance.listMessages(
        companyId,
        conversationId,
        toListOptions(query),
        query.order,
      );
      const conversation = toConversationResponse(
        page.conversation,
        attendance.activePause(page.conversation),
      );
      const open =
        notifications === undefined
          ? undefined
          : await notifications.openHandoffs(companyId, [conversation.id]);
      return {
        // A conversa vai junto (rótulo mascarado e canal): o histórico abre pelo id, também ao recarregar.
        conversation:
          open === undefined
            ? conversation
            : { ...conversation, openHandoff: toOpenHandoffResponse(open.get(conversation.id)) },
        items: page.items.map(toMessageResponse),
        nextCursor: page.nextCursor,
      };
    },
  );

  // Spec 039 (E4): reativa a IA numa conversa pausada porque a equipe respondeu pelo celular. 204
  // idempotente; `:conversationId` malformado, inexistente ou de outra empresa = o mesmo 404.
  app.post(
    '/:companyId/conversations/:conversationId/ai/resume',
    { config, onRequest: guard('conversation:takeover') },
    async (request, reply) => {
      const { conversationId } = conversationParamsSchema.parse(request.params);
      const { companyId } = membershipAuth(request);
      await attendance.resumeAi(companyId, conversationId);
      return reply.status(204).send();
    },
  );

  done();
};
