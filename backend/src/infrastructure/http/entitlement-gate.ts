import type { FastifyInstance } from 'fastify';
import type { EntitlementReader } from '../../application/ports/entitlement-reader.js';
import { ForbiddenError } from '../../shared/errors/index.js';
import { routePattern } from '../../presentation/common/route-pattern.js';

/** Prefixo das rotas de tenant (spec 031: a política vale para toda escrita sob ele). */
const TENANT_ROUTE_PREFIX = '/admin/companies/:companyId/';
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Política de assinatura das escritas de tenant (spec 031, E2). Hook `preHandler` da instância raiz:
 * roda **depois** de todos os hooks `onRequest` das rotas (autenticação, `requirePermission` com
 * 401 -> 403 plataforma -> 404 -> 403 papel), então a ordem de recusa é preservada e o `PlatformAdmin`
 * segue sem acesso. Para escrita (`POST`, `PUT`, `PATCH`, `DELETE`) numa rota de tenant:
 * - assinatura inativa -> 403 `SUBSCRIPTION_INACTIVE` (leitura, exportação, login, Assinatura,
 *   `entitlements`, desconectar o canal e a equipe seguem: ver `subscriptionExempt`);
 * - rota que declara módulo (`requiresModule`) sem o módulo contratado -> 403 `MODULE_NOT_CONTRACTED`.
 * Leitura nunca é barrada. **Fail-open** se o leitor falha (não se bloqueia a empresa por falha nossa;
 * log `warn` só com o padrão da rota e o nome do erro). Sem leitor (cobrança desligada) o hook nem é
 * registrado: as rotas têm exatamente o custo de antes.
 */
export function registerEntitlementGate(
  app: FastifyInstance,
  reader: Pick<EntitlementReader, 'forCompany'>,
): void {
  app.addHook('preHandler', async (request) => {
    if (READ_METHODS.has(request.method)) return;
    const { config, url } = request.routeOptions;
    if (url === undefined || !url.startsWith(TENANT_ROUTE_PREFIX)) return;
    if (config.subscriptionExempt === true) return;
    const auth = request.auth;
    if (auth?.kind !== 'membership') return;
    let entitlements;
    try {
      entitlements = await reader.forCompany(auth.companyId);
    } catch (error) {
      request.log.warn(
        {
          route: routePattern(request),
          errorName: error instanceof Error ? error.name : 'unknown',
        },
        'assinatura indisponível; escrita liberada',
      );
      return;
    }
    if (entitlements.access === 'blocked') {
      throw new ForbiddenError('Assinatura inativa', { code: 'SUBSCRIPTION_INACTIVE' });
    }
    const module = config.requiresModule;
    if (
      module !== undefined &&
      !(module === 'schedule' ? entitlements.agenda : entitlements.stock)
    ) {
      throw new ForbiddenError('Módulo não contratado', { code: 'MODULE_NOT_CONTRACTED' });
    }
  });
}
