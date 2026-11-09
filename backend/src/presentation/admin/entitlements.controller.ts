import type { FastifyPluginCallback } from 'fastify';
import type { AuthService } from '../../application/auth/auth.service.js';
import type {
  EntitlementReader,
  SubscriptionHolderReader,
} from '../../application/ports/entitlement-reader.js';
import { UNLIMITED_ENTITLEMENTS } from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { authenticateHook, membershipAuth, requirePermission } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import { subscriptionExempt } from '../common/entitlement-config.js';

export interface AdminEntitlementsControllerOptions {
  readonly auth: Pick<AuthService, 'authenticate'>;
  readonly metrics?: Pick<Metrics, 'countAuthTokenRejection' | 'countAuthzDenial'> | undefined;
  /** Sem leitor (cobrança desligada) tudo está liberado e nada tem cota. */
  readonly entitlements?:
    | (Pick<EntitlementReader, 'forCompany'> & Partial<SubscriptionHolderReader>)
    | undefined;
}

/**
 * `GET /admin/companies/:companyId/entitlements` (spec 031): o que a empresa selecionada pode fazer
 * agora, para qualquer papel. **Sem dinheiro** e só da empresa do token (404 se `:companyId` difere,
 * antes de qualquer outra coisa). **Efeito colateral:** com a cobrança ligada, ler os entitlements de uma
 * empresa sem assinatura a ADOTA (assinatura da conta do OWNER ativo e, uma vez por conta, o teste gratuito). O site o usa para esconder abas de módulos e mostrar as faixas de
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
      const { companyId, membershipId } = membershipAuth(request);
      if (entitlements === undefined) return { ...UNLIMITED_ENTITLEMENTS, holder: false };
      const result = await entitlements.forCompany(companyId);
      // Só um booleano: a conta logada é a titular da assinatura DESTA empresa (nunca dado de outra conta).
      const holder = (await entitlements.holderOf?.(companyId, membershipId)) ?? false;
      return { ...result, holder };
    },
  );
  done();
};
