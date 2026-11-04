import type { FastifyPluginCallback } from 'fastify';
import type { AuthService } from '../../application/auth/auth.service.js';
import type { MembershipAdminService } from '../../application/memberships/membership-admin.service.js';
import type { AuditEvent } from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { authenticateHook, requirePermission, membershipAuth } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import { listQuerySchema } from './attendance.validators.js';
import { toListOptions } from './list-options.js';

export interface AdminAuditControllerOptions {
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?: Pick<Metrics, 'countAuthTokenRejection' | 'countAuthzDenial'> | undefined;
  readonly memberships: Pick<MembershipAdminService, 'listAuditEvents'>;
}

function toAuditResponse(event: AuditEvent): {
  id: string;
  action: string;
  actorMembershipId: string;
  targetMembershipId: string | null;
  fromRole: string | null;
  toRole: string | null;
  createdAt: string;
} {
  return {
    id: event.id,
    action: event.action,
    actorMembershipId: event.actorMembershipId,
    targetMembershipId: event.targetMembershipId,
    fromRole: event.fromRole,
    toRole: event.toRole,
    createdAt: event.createdAt.toISOString(),
  };
}

/**
 * Trilha de auditoria da empresa (spec 008), só leitura. Registre com `prefix: '/admin/companies'`.
 * Autoprotegida pelo `companyId` do token (o `:companyId` do caminho é só conferido). Só ids e valores
 * de enum: nunca e-mail, IP nem texto livre.
 */
export const adminAuditController: FastifyPluginCallback<AdminAuditControllerOptions> = (
  app,
  { auth, metrics, memberships },
  done,
) => {
  app.addHook('onRequest', authenticateHook({ auth, metrics }));
  app.get(
    '/:companyId/audit-events',
    {
      config: rateLimitProfile('admin'),
      onRequest: requirePermission('audit:read', { companyParam: 'companyId', metrics }),
    },
    async (request) => {
      const query = listQuerySchema.parse(request.query);
      const page = await memberships.listAuditEvents(membershipAuth(request), toListOptions(query));
      return { items: page.items.map(toAuditResponse), nextCursor: page.nextCursor };
    },
  );
  done();
};
