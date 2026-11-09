import type { FastifyPluginCallback } from 'fastify';
import type { AuthService } from '../../application/auth/auth.service.js';
import type { EntitlementReader } from '../../application/ports/entitlement-reader.js';
import { UNLIMITED_ENTITLEMENTS } from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { authenticateHook, membershipAuth, requirePermission } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import { subscriptionExempt } from '../common/entitlement-config.js';

export interface AdminEntitlementsControllerOptions {
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?: Pick<Metrics, 'countAuthTokenRejection' | 'countAuthzDenial'> | undefined;
  /** Sem leitor (cobrança desligada) tudo está liberado e nada tem cota. */
  readonly entitlements?: Pick<EntitlementReader, 'forCompany'> | undefined;
}

/**
 * `GET /admin/companies/:companyId/entitlements` (spec 031): o que a empresa selecionada pode fazer
 * agora, para qualquer papel. **Sem dinheiro** e só da empresa do token (404 se `:companyId` difere,
 * antes de qualquer outra coisa). O site o usa para esconder abas de módulos e mostrar as faixas de
 * carência e bloqueio; a barreira é o backend.
 */
export const adminEntitlementsController: FastifyPluginCallback<
  AdminEntitlementsControllerOptions
> = (app, { auth, metrics, entitlements }, done) => {
  app.addHook('onRequest', authenticateHook({ auth, metrics }));
  app.get(
    '/:companyId/entitlements',
    {
      config: { ...rateLimitProfile('admin'), ...subscriptionExempt() },
      onRequest: requirePermission('conversation:read', { companyParam: 'companyId', metrics }),
    },
    async (request) => {
      const { companyId } = membershipAuth(request);
      return entitlements === undefined
        ? UNLIMITED_ENTITLEMENTS
        : await entitlements.forCompany(companyId);
    },
  );
  done();
};
