import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../../application/auth/auth.service.js';
import type { OnboardingService } from '../../application/onboarding/onboarding.service.js';
import { hasPermission } from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { authenticateHook, requirePermission, membershipAuth } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';

export interface AdminOnboardingControllerOptions {
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?:
    | Pick<Metrics, 'countAuthTokenRejection' | 'countAuthzDenial' | 'countCompanyOnboardingAction'>
    | undefined;
  readonly onboarding: Pick<OnboardingService, 'get' | 'setDismissed'>;
}

/** Corpo de `PUT .../onboarding` (spec 030): só `dismissed`, nada mais; erro de validação não ecoa o valor. */
export const putOnboardingBodySchema = z.object({ dismissed: z.boolean() }).strict();

/**
 * Assistente de primeiros passos da própria empresa (spec 030). Registre com
 * `prefix: '/admin/companies'`. O `:companyId` do caminho é conferido contra a identidade pelo
 * `requirePermission` (404 antes de 403) e descartado: o service recebe só o `CompanyId` da
 * identidade. A resposta tem só booleanos; nada de persona, documento, produto ou serviço.
 */
export const adminOnboardingController: FastifyPluginCallback<AdminOnboardingControllerOptions> = (
  app,
  { auth, metrics, onboarding },
  done,
) => {
  app.addHook('onRequest', authenticateHook({ auth, metrics }));
  const config = rateLimitProfile('admin');
  const onRequest = requirePermission('onboarding:manage', { companyParam: 'companyId', metrics });

  app.get('/:companyId/onboarding', { config, onRequest }, async (request) => {
    const { companyId, role } = membershipAuth(request);
    return await onboarding.get(companyId, (permission) => hasPermission(role, permission));
  });

  app.put('/:companyId/onboarding', { config, onRequest }, async (request) => {
    const { companyId, membershipId, role } = membershipAuth(request);
    const body = putOnboardingBodySchema.parse(request.body);
    const { state, changed } = await onboarding.setDismissed(
      companyId,
      body.dismissed,
      (permission) => hasPermission(role, permission),
    );
    const action = body.dismissed ? 'dismissed' : 'reopened';
    if (changed) {
      try {
        metrics?.countCompanyOnboardingAction(action);
      } catch (error) {
        request.log.warn({ err: error }, 'falha ao registrar métrica do assistente');
      }
    }
    // Só ids, a ação e o resultado: nunca conteúdo da empresa.
    request.log.info({ companyId, membershipId, action, changed }, 'onboarding atualizado');
    return state;
  });

  done();
};
