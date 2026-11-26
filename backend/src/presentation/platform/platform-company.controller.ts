import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import type { PlatformIdentity } from '../../application/auth/identity.js';
import type { PlatformCompanyService } from '../../application/platform/platform-company.service.js';
import { UnauthorizedError } from '../../shared/errors/index.js';
import { requestAuth, requirePlatform } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import {
  platformActionBodySchema,
  platformCompanyParamsSchema,
  platformConfirmedActionBodySchema,
  platformMembershipParamsSchema,
  platformRemoveCompanyBodySchema,
  platformRenameBodySchema,
  platformRoleBodySchema,
} from './platform-monitor.validators.js';

export type PlatformCompanyRoutes = Pick<
  PlatformCompanyService,
  'rename' | 'remove' | 'restore' | 'changeRole' | 'setMembershipStatus' | 'disconnectChannel'
>;

export interface PlatformCompanyControllerOptions {
  readonly companies: PlatformCompanyRoutes;
}

function platformIdentity(request: FastifyRequest): PlatformIdentity {
  const identity = requestAuth(request);
  if (identity.kind !== 'platform') throw new UnauthorizedError();
  return identity;
}

/**
 * Ações do admin da plataforma sobre empresas e vínculos (spec 045, E3a). Registrado **dentro** do plugin
 * `/platform` (o hook dele preenche a identidade só pelo cookie com segundo fator e confere `Origin` e
 * `X-Soprei-App` em toda escrita). Toda rota: `requirePlatform()` e perfil `admin`; corpo Zod `strict`;
 * id malformado, inexistente ou de outra empresa = 404 uniforme. Respostas 204 sem corpo.
 */
export const platformCompanyController: FastifyPluginCallback<PlatformCompanyControllerOptions> = (
  app,
  { companies },
  done,
) => {
  const route = { config: rateLimitProfile('admin'), onRequest: requirePlatform() };

  app.post('/companies/:companyId/rename', route, async (request, reply) => {
    const identity = platformIdentity(request);
    const { companyId } = platformCompanyParamsSchema.parse(request.params);
    const { name, reason } = platformRenameBodySchema.parse(request.body);
    await companies.rename(identity, companyId, name, reason);
    return reply.status(204).send();
  });

  app.post('/companies/:companyId/remove', route, async (request, reply) => {
    const identity = platformIdentity(request);
    const { companyId } = platformCompanyParamsSchema.parse(request.params);
    const { reason, slug, code } = platformRemoveCompanyBodySchema.parse(request.body);
    await companies.remove(identity, companyId, slug, reason, code);
    return reply.status(204).send();
  });

  // Spec 045, E5: desconectar o WhatsApp (**[código]**); sem o canal ligado, 404.
  app.post('/companies/:companyId/channel/disconnect', route, async (request, reply) => {
    const identity = platformIdentity(request);
    const { companyId } = platformCompanyParamsSchema.parse(request.params);
    const { reason, code } = platformConfirmedActionBodySchema.parse(request.body);
    await companies.disconnectChannel(identity, companyId, reason, code);
    return reply.status(204).send();
  });

  app.post('/companies/:companyId/restore', route, async (request, reply) => {
    const identity = platformIdentity(request);
    const { companyId } = platformCompanyParamsSchema.parse(request.params);
    const { reason, code } = platformConfirmedActionBodySchema.parse(request.body);
    await companies.restore(identity, companyId, reason, code);
    return reply.status(204).send();
  });

  app.post(
    '/companies/:companyId/memberships/:membershipId/role',
    route,
    async (request, reply) => {
      const identity = platformIdentity(request);
      const { companyId, membershipId } = platformMembershipParamsSchema.parse(request.params);
      const { role, reason, code } = platformRoleBodySchema.parse(request.body);
      await companies.changeRole(identity, companyId, membershipId, role, reason, code);
      return reply.status(204).send();
    },
  );

  for (const [path, target] of [
    ['disable', 'DISABLED'],
    ['enable', 'ACTIVE'],
  ] as const) {
    app.post(
      `/companies/:companyId/memberships/:membershipId/${path}`,
      route,
      async (request, reply) => {
        const identity = platformIdentity(request);
        const { companyId, membershipId } = platformMembershipParamsSchema.parse(request.params);
        const { reason } = platformActionBodySchema.parse(request.body);
        await companies.setMembershipStatus(identity, companyId, membershipId, target, reason);
        return reply.status(204).send();
      },
    );
  }

  done();
};
