import type { FastifyPluginCallback } from 'fastify';
import type { AuthService } from '../../application/auth/auth.service.js';
import type { UserAdminService } from '../../application/users/user-admin.service.js';
import type { AuditEvent } from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { authenticateHook, requirePermission, userAuth } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import { listQuerySchema } from './attendance.validators.js';
import { toListOptions } from './list-options.js';

export interface AdminAuditControllerOptions {
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?: Pick<Metrics, 'countAuthTokenRejection' | 'countAuthzDenial'> | undefined;
  readonly users: Pick<UserAdminService, 'listAuditEvents'>;
}

function toAuditResponse(event: AuditEvent): {
  id: string;
  action: string;
  actorUserId: string;
  targetUserId: string | null;
  fromRole: string | null;
  toRole: string | null;
  createdAt: string;
} {
  return {
    id: event.id,
    action: event.action,
    actorUserId: event.actorUserId,
    targetUserId: event.targetUserId,
    fromRole: event.fromRole,
    toRole: event.toRole,
    createdAt: event.createdAt.toISOString(),
  };
}

/**
 * Trilha de auditoria do cliente (spec 008), só leitura. Registre com `prefix: '/admin/clients'`.
 * Autoprotegida pelo `clientId` do token (o `:clientId` do caminho é só conferido). Só ids e valores
 * de enum: nunca e-mail, IP nem texto livre.
 */
export const adminAuditController: FastifyPluginCallback<AdminAuditControllerOptions> = (
  app,
  { auth, metrics, users },
  done,
) => {
  app.addHook('onRequest', authenticateHook({ auth, metrics }));
  app.get(
    '/:clientId/audit-events',
    {
      config: rateLimitProfile('admin'),
      onRequest: requirePermission('audit:read', { clientParam: 'clientId', metrics }),
    },
    async (request) => {
      const query = listQuerySchema.parse(request.query);
      const page = await users.listAuditEvents(userAuth(request), toListOptions(query));
      return { items: page.items.map(toAuditResponse), nextCursor: page.nextCursor };
    },
  );
  done();
};
