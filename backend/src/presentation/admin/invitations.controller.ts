import type { FastifyPluginCallback, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { AuthService } from '../../application/auth/auth.service.js';
import type {
  InvitationService,
  InvitationView,
} from '../../application/invitations/invitation.service.js';
import type { Permission } from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { NotFoundError } from '../../shared/errors/index.js';
import { isUuid } from '../../shared/utils/index.js';
import { authenticateHook, requirePermission, membershipAuth } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import { listQuerySchema } from './attendance.validators.js';
import { createInvitationBodySchema } from './invitations.validators.js';
import { toListOptions } from './list-options.js';

export interface AdminInvitationsControllerOptions {
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?: Pick<Metrics, 'countAuthTokenRejection' | 'countAuthzDenial'> | undefined;
  readonly invitations: Pick<InvitationService, 'list' | 'create' | 'resend' | 'revoke'>;
}

interface InvitationResponse {
  id: string;
  email: string;
  role: string;
  state: string;
  createdAt: string;
  expiresAt: string;
  lastSentAt: string;
  sendCount: number;
}

function toInvitationResponse(invitation: InvitationView): InvitationResponse {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    state: invitation.state,
    createdAt: invitation.createdAt.toISOString(),
    expiresAt: invitation.expiresAt.toISOString(),
    lastSentAt: invitation.lastSentAt.toISOString(),
    sendCount: invitation.sendCount,
  };
}

/** `:invitationId` que não é UUID nunca existe: 404 uniforme, igual a convite de outra empresa. */
function targetInvitationId(request: FastifyRequest): string {
  const { invitationId } = request.params as { invitationId?: unknown };
  if (typeof invitationId !== 'string' || !isUuid(invitationId)) {
    throw new NotFoundError('Recurso não encontrado', { context: { entity: 'CompanyInvitation' } });
  }
  return invitationId.toLowerCase();
}

/**
 * Convites da própria empresa (spec 025). Registre com `prefix: '/admin/companies'`. As permissões são
 * as da gestão de membros (`membership:read` e `membership:manage`): nenhum caminho de autorização
 * novo. O `:companyId` do caminho é conferido contra a identidade (404 antes de 403) e descartado: o
 * service sempre recebe a identidade. Rotas finas; hierarquia, cotas e auditoria moram no service. Nunca
 * logam o e-mail do convidado.
 */
export const adminInvitationsController: FastifyPluginCallback<
  AdminInvitationsControllerOptions
> = (app, { auth, metrics, invitations }, done) => {
  app.addHook('onRequest', authenticateHook({ auth, metrics }));
  const config = rateLimitProfile('admin');
  const guard = (permission: Permission): onRequestAsyncHookHandler =>
    requirePermission(permission, { companyParam: 'companyId', metrics });

  app.get(
    '/:companyId/invitations',
    { config, onRequest: guard('membership:read') },
    async (request) => {
      const query = listQuerySchema.parse(request.query);
      const page = await invitations.list(membershipAuth(request), toListOptions(query));
      return { items: page.items.map(toInvitationResponse), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/:companyId/invitations',
    { config, onRequest: guard('membership:manage') },
    async (request, reply) => {
      const body = createInvitationBodySchema.parse(request.body);
      const created = await invitations.create(membershipAuth(request), body);
      return reply.status(201).send(toInvitationResponse(created));
    },
  );

  app.post(
    '/:companyId/invitations/:invitationId/resend',
    { config, onRequest: guard('membership:manage') },
    async (request) => {
      const invitationId = targetInvitationId(request);
      const renewed = await invitations.resend(membershipAuth(request), invitationId);
      return toInvitationResponse(renewed);
    },
  );

  app.delete(
    '/:companyId/invitations/:invitationId',
    { config, onRequest: guard('membership:manage') },
    async (request, reply) => {
      const invitationId = targetInvitationId(request);
      await invitations.revoke(membershipAuth(request), invitationId);
      return reply.status(204).send();
    },
  );

  done();
};
