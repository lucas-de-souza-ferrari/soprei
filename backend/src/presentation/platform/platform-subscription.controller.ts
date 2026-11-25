import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PlatformIdentity } from '../../application/auth/identity.js';
import {
  PLATFORM_EXTEND_MAX_DAYS,
  PLATFORM_EXTEND_MIN_DAYS,
  type PlatformSubscriptionService,
} from '../../application/platform/platform-subscription.service.js';
import { PLAN_CODES, PLATFORM_ACTION_REASONS } from '../../domain/index.js';
import { UnauthorizedError } from '../../shared/errors/index.js';
import { requestAuth, requirePlatform } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import {
  platformAccountParamsSchema,
  platformActionBodySchema,
  platformConfirmedActionBodySchema,
} from './platform-monitor.validators.js';

export type PlatformSubscriptionRoutes = Pick<
  PlatformSubscriptionService,
  'startTrial' | 'extend' | 'setModules' | 'changePlan' | 'setCancelAtPeriodEnd' | 'end'
>;

export interface PlatformSubscriptionControllerOptions {
  readonly subscriptions: PlatformSubscriptionRoutes;
}

const reason = z.enum(PLATFORM_ACTION_REASONS);

const extendBodySchema = z
  .object({
    days: z.number().int().min(PLATFORM_EXTEND_MIN_DAYS).max(PLATFORM_EXTEND_MAX_DAYS),
    reason,
  })
  .strict();
const modulesBodySchema = z.object({ agenda: z.boolean(), stock: z.boolean(), reason }).strict();
const planBodySchema = z.object({ planCode: z.enum(PLAN_CODES), reason }).strict();

function platformIdentity(request: FastifyRequest): PlatformIdentity {
  const identity = requestAuth(request);
  if (identity.kind !== 'platform') throw new UnauthorizedError();
  return identity;
}

/**
 * Ações do admin da plataforma sobre a assinatura de uma conta (spec 045, E4), todas em
 * `/platform/accounts/:accountId/subscription/...` (a assinatura é da conta). Registrado **dentro** do
 * plugin `/platform` (cookie com segundo fator; escrita exige `Origin` e `X-Soprei-App`). Toda rota:
 * `requirePlatform()` e perfil `admin`; corpo `strict`; respostas 204 sem corpo (nada de dinheiro, link nem
 * dado de pagamento). Cobrança desligada = 409 `BILLING_DISABLED` (as rotas existem, para o app explicar).
 */
export const platformSubscriptionController: FastifyPluginCallback<
  PlatformSubscriptionControllerOptions
> = (app, { subscriptions }, done) => {
  const route = { config: rateLimitProfile('admin'), onRequest: requirePlatform() };
  const base = '/accounts/:accountId/subscription';

  app.post(`${base}/trial`, route, async (request, reply) => {
    const identity = platformIdentity(request);
    const { accountId } = platformAccountParamsSchema.parse(request.params);
    const body = platformActionBodySchema.parse(request.body);
    await subscriptions.startTrial(identity, accountId, body.reason);
    return reply.status(204).send();
  });

  app.post(`${base}/extend`, route, async (request, reply) => {
    const identity = platformIdentity(request);
    const { accountId } = platformAccountParamsSchema.parse(request.params);
    const body = extendBodySchema.parse(request.body);
    await subscriptions.extend(identity, accountId, body.days, body.reason);
    return reply.status(204).send();
  });

  app.post(`${base}/modules`, route, async (request, reply) => {
    const identity = platformIdentity(request);
    const { accountId } = platformAccountParamsSchema.parse(request.params);
    const body = modulesBodySchema.parse(request.body);
    await subscriptions.setModules(
      identity,
      accountId,
      { agenda: body.agenda, stock: body.stock },
      body.reason,
    );
    return reply.status(204).send();
  });

  app.post(`${base}/plan`, route, async (request, reply) => {
    const identity = platformIdentity(request);
    const { accountId } = platformAccountParamsSchema.parse(request.params);
    const body = planBodySchema.parse(request.body);
    await subscriptions.changePlan(identity, accountId, body.planCode, body.reason);
    return reply.status(204).send();
  });

  for (const [path, cancel] of [
    ['cancel', true],
    ['reactivate', false],
  ] as const) {
    app.post(`${base}/${path}`, route, async (request, reply) => {
      const identity = platformIdentity(request);
      const { accountId } = platformAccountParamsSchema.parse(request.params);
      const body = platformActionBodySchema.parse(request.body);
      await subscriptions.setCancelAtPeriodEnd(identity, accountId, cancel, body.reason);
      return reply.status(204).send();
    });
  }

  app.post(`${base}/end`, route, async (request, reply) => {
    const identity = platformIdentity(request);
    const { accountId } = platformAccountParamsSchema.parse(request.params);
    const body = platformConfirmedActionBodySchema.parse(request.body);
    await subscriptions.end(identity, accountId, body.reason, body.code);
    return reply.status(204).send();
  });

  done();
};
