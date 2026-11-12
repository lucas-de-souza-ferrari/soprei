import type { FastifyPluginCallback, onRequestAsyncHookHandler } from 'fastify';
import { describeContact } from '../../application/attendance/contact-label.js';
import type { AttendanceService } from '../../application/attendance/attendance.service.js';
import type { AuthService } from '../../application/auth/auth.service.js';
import type { NotificationService } from '../../application/notifications/notification.service.js';
import type { CompanyId, Notification, Permission } from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { authenticateHook, membershipAuth, requirePermission } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import {
  NOTIFICATIONS_DEFAULT_LIMIT,
  notificationParamsSchema,
  notificationsQuerySchema,
} from './notifications.validators.js';

export interface AdminNotificationsControllerOptions {
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?: Pick<Metrics, 'countAuthTokenRejection' | 'countAuthzDenial'> | undefined;
  readonly notifications: Pick<NotificationService, 'list' | 'countOpen' | 'resolve'>;
  /** Para o rótulo mascarado do contato de cada notificação (spec 024). */
  readonly attendance: Pick<AttendanceService, 'getConversationsByIds'>;
}

interface NotificationResponse {
  id: string;
  kind: string;
  reason: string | null;
  status: string;
  conversation: { id: string; contactLabel: string; channel: string } | null;
  createdAt: string;
  resolvedAt: string | null;
  /** Quem resolveu é a pessoa logada? O id do vínculo nunca sai. */
  resolvedByMe: boolean;
}

/**
 * Notificações do painel (spec 038), só para `Membership`. Registre com `prefix: '/admin/companies'`.
 * O `:companyId` do caminho é conferido contra a identidade (divergência = 404) e descartado; o service
 * sempre recebe o `companyId` autenticado. A resposta **nunca** traz `contactRef`, `externalId`, texto
 * de mensagem nem o id de quem resolveu.
 */
export const adminNotificationsController: FastifyPluginCallback<
  AdminNotificationsControllerOptions
> = (app, { auth, metrics, notifications, attendance }, done) => {
  app.addHook('onRequest', authenticateHook({ auth, metrics }));
  const config = rateLimitProfile('admin');
  const guard = (permission: Permission): onRequestAsyncHookHandler =>
    requirePermission(permission, { companyParam: 'companyId', metrics });

  async function toResponses(
    companyId: CompanyId,
    membershipId: string,
    items: readonly Notification[],
  ): Promise<NotificationResponse[]> {
    const conversations = await attendance.getConversationsByIds(
      companyId,
      items.map((item) => item.conversationId),
    );
    return items.map((item) => {
      const conversation = conversations.get(item.conversationId);
      const contact =
        conversation === undefined
          ? null
          : {
              id: conversation.id,
              ...describeContact(conversation.companyId, conversation.contactRef),
            };
      return {
        id: item.id,
        kind: item.kind,
        reason: item.reason,
        status: item.status,
        conversation: contact,
        createdAt: item.createdAt.toISOString(),
        resolvedAt: item.resolvedAt === null ? null : item.resolvedAt.toISOString(),
        resolvedByMe: item.resolvedByMembershipId === membershipId,
      };
    });
  }

  app.get(
    '/:companyId/notifications',
    { config, onRequest: guard('notification:read') },
    async (request) => {
      const { companyId, membershipId } = membershipAuth(request);
      const query = notificationsQuerySchema.parse(request.query);
      const page = await notifications.list(companyId, query.status ?? 'open', {
        limit: query.limit ?? NOTIFICATIONS_DEFAULT_LIMIT,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
      return {
        items: await toResponses(companyId, membershipId, page.items),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.get(
    '/:companyId/notifications/summary',
    { config, onRequest: guard('notification:read') },
    async (request) => {
      const { companyId } = membershipAuth(request);
      return { open: await notifications.countOpen(companyId) };
    },
  );

  app.post(
    '/:companyId/notifications/:notificationId/resolve',
    { config, onRequest: guard('notification:resolve') },
    async (request, reply) => {
      const { notificationId } = notificationParamsSchema.parse(request.params);
      const { companyId, membershipId } = membershipAuth(request);
      await notifications.resolve(companyId, notificationId, membershipId);
      return reply.status(204).send();
    },
  );

  done();
};
