import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import type { PlatformIdentity } from '../../application/auth/identity.js';
import type { PlatformAccountService } from '../../application/platform/platform-account.service.js';
import { UnauthorizedError } from '../../shared/errors/index.js';
import { requestAuth, requirePlatform } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import {
  platformAccountParamsSchema,
  platformActionBodySchema,
  platformConfirmedActionBodySchema,
} from './platform-monitor.validators.js';

export type PlatformAccountRoutes = Pick<
  PlatformAccountService,
  'setStatus' | 'revokeSessions' | 'sendPasswordReset' | 'resendVerification'
>;

export interface PlatformAccountControllerOptions {
  readonly accounts: PlatformAccountRoutes;
}

function platformIdentity(request: FastifyRequest): PlatformIdentity {
  const identity = requestAuth(request);
  if (identity.kind !== 'platform') throw new UnauthorizedError();
  return identity;
}

/**
 * Ações do admin da plataforma sobre uma conta (spec 045, E2). Registrado **dentro** do plugin `/platform`
 * (o hook dele preenche a identidade só pelo cookie com segundo fator e confere `Origin` e `X-Soprei-App`
 * em toda escrita). Toda rota: `requirePlatform()` e perfil `admin`; corpo Zod `strict`; id malformado ou
 * inexistente = 404 uniforme. Respostas sem corpo (nada de e-mail, código nem senha).
 */
export const platformAccountController: FastifyPluginCallback<PlatformAccountControllerOptions> = (
  app,
  { accounts },
  done,
) => {
  const route = { config: rateLimitProfile('admin'), onRequest: requirePlatform() };

  for (const [path, target] of [
    ['disable', 'DISABLED'],
    ['enable', 'ACTIVE'],
  ] as const) {
    app.post(`/accounts/:accountId/${path}`, route, async (request, reply) => {
      const identity = platformIdentity(request);
      const { accountId } = platformAccountParamsSchema.parse(request.params);
      const { reason, code } = platformConfirmedActionBodySchema.parse(request.body);
      await accounts.setStatus(identity, accountId, target, reason, code);
      return reply.status(204).send();
    });
  }

  app.post('/accounts/:accountId/sessions/revoke', route, async (request, reply) => {
    const identity = platformIdentity(request);
    const { accountId } = platformAccountParamsSchema.parse(request.params);
    const { reason } = platformActionBodySchema.parse(request.body);
    await accounts.revokeSessions(identity, accountId, reason);
    return reply.status(204).send();
  });

  app.post('/accounts/:accountId/password-reset', route, async (request, reply) => {
    const identity = platformIdentity(request);
    const { accountId } = platformAccountParamsSchema.parse(request.params);
    const { reason } = platformActionBodySchema.parse(request.body);
    await accounts.sendPasswordReset(identity, accountId, reason);
    return reply.status(202).send();
  });

  app.post('/accounts/:accountId/verification/resend', route, async (request, reply) => {
    const identity = platformIdentity(request);
    const { accountId } = platformAccountParamsSchema.parse(request.params);
    const { reason } = platformActionBodySchema.parse(request.body);
    await accounts.resendVerification(identity, accountId, reason);
    return reply.status(202).send();
  });

  done();
};
