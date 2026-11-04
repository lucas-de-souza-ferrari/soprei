import type { FastifyPluginCallback, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { AuthService } from '../../application/auth/auth.service.js';
import type {
  MembershipAdminService,
  MembershipView,
} from '../../application/memberships/membership-admin.service.js';
import type { Permission } from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { NotFoundError } from '../../shared/errors/index.js';
import { isUuid } from '../../shared/utils/index.js';
import { authenticateHook, requirePermission, membershipAuth } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import { listQuerySchema } from './attendance.validators.js';
import { toListOptions } from './list-options.js';
import {
  createMembershipBodySchema,
  resetPasswordBodySchema,
  updateMembershipBodySchema,
} from './memberships.validators.js';

export interface AdminMembershipsControllerOptions {
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?: Pick<Metrics, 'countAuthTokenRejection' | 'countAuthzDenial'> | undefined;
  readonly memberships: MembershipAdminService;
}

interface MembershipResponse {
  id: string;
  email: string;
  role: string;
  status: string;
  createdAt: string;
}

function toMembershipResponse(membership: MembershipView): MembershipResponse {
  return {
    id: membership.id,
    email: membership.email,
    role: membership.role,
    status: membership.status,
    createdAt: membership.createdAt.toISOString(),
  };
}

/** `:membershipId` que não é UUID nunca existe: 404 uniforme (não 400), igual a usuário de outra empresa. */
function targetMembershipId(request: FastifyRequest): string {
  const { membershipId } = request.params as { membershipId?: unknown };
  if (typeof membershipId !== 'string' || !isUuid(membershipId)) {
    throw new NotFoundError('Recurso não encontrado', { context: { entity: 'Membership' } });
  }
  return membershipId.toLowerCase();
}

/**
 * Gestão de usuários da própria empresa (spec 008). Registre com `prefix: '/admin/companies'`. O
 * `:companyId` do caminho é conferido contra o do token pelo `requirePermission` (404 antes de 403)
 * e descartado: o service sempre recebe a identidade do token. Rotas finas; a hierarquia, a
 * regra do último `OWNER` e a auditoria moram no service. Nunca logam e-mail nem senha.
 */
export const adminMembershipsController: FastifyPluginCallback<
  AdminMembershipsControllerOptions
> = (app, { auth, metrics, memberships }, done) => {
  app.addHook('onRequest', authenticateHook({ auth, metrics }));
  const config = rateLimitProfile('admin');
  const guard = (permission: Permission): onRequestAsyncHookHandler =>
    requirePermission(permission, { companyParam: 'companyId', metrics });

  app.get(
    '/:companyId/memberships',
    { config, onRequest: guard('membership:read') },
    async (request) => {
      const query = listQuerySchema.parse(request.query);
      const page = await memberships.listMemberships(membershipAuth(request), toListOptions(query));
      return { items: page.items.map(toMembershipResponse), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/:companyId/memberships',
    { config, onRequest: guard('membership:manage') },
    async (request, reply) => {
      const body = createMembershipBodySchema.parse(request.body);
      const created = await memberships.createMembership(membershipAuth(request), body);
      return reply.status(201).send(toMembershipResponse(created));
    },
  );

  app.patch(
    '/:companyId/memberships/:membershipId',
    { config, onRequest: guard('membership:manage') },
    async (request) => {
      const membershipId = targetMembershipId(request);
      const body = updateMembershipBodySchema.parse(request.body);
      const updated = await memberships.updateMembership(membershipAuth(request), membershipId, {
        ...(body.role === undefined ? {} : { role: body.role }),
        ...(body.status === undefined ? {} : { status: body.status }),
      });
      return toMembershipResponse(updated);
    },
  );

  app.post(
    '/:companyId/memberships/:membershipId/password',
    { config, onRequest: guard('membership:manage') },
    async (request, reply) => {
      const membershipId = targetMembershipId(request);
      const { newPassword } = resetPasswordBodySchema.parse(request.body);
      await memberships.resetPassword(membershipAuth(request), membershipId, newPassword);
      return reply.status(204).send();
    },
  );

  done();
};
