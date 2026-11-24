import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import type {
  PlatformAccountDetail,
  PlatformAccountListItem,
  PlatformBillingPage,
  PlatformCompanyDetail,
  PlatformCompanyListItem,
  PlatformHealth,
  PlatformMonitorService,
  PlatformOverview,
} from '../../application/platform/platform-monitor.service.js';
import type { PlatformIdentity } from '../../application/auth/identity.js';
import type {
  PlatformNoticeRow,
  PlatformOrderRow,
  PlatformPage,
} from '../../application/ports/platform-read-model.js';
import { UnauthorizedError } from '../../shared/errors/index.js';
import { requestAuth, requirePlatform } from '../common/auth.hooks.js';
import { rateLimitProfile } from '../common/rate-limit.js';
import {
  platformAccountParamsSchema,
  platformAccountsQuerySchema,
  platformActionBodySchema,
  platformCompaniesQuerySchema,
  platformCompanyParamsSchema,
  platformNoticesQuerySchema,
  platformOrdersQuerySchema,
} from './platform-monitor.validators.js';

/** Como o tipo vira JSON: datas viram texto ISO 8601 (UTC). */
export type Jsonified<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? readonly Jsonified<U>[]
    : T extends object
      ? { readonly [K in keyof T]: Jsonified<T[K]> }
      : T;

// Contratos das rotas `/platform/*` da E2 (o app `admin/` da E3 os consome).
/** `GET /platform/overview`. */
export type PlatformOverviewResponse = Jsonified<PlatformOverview>;
/** `GET /platform/companies`. */
export type PlatformCompanyListResponse = Jsonified<PlatformPage<PlatformCompanyListItem>>;
/** `GET /platform/companies/:companyId`. */
export type PlatformCompanyDetailResponse = Jsonified<PlatformCompanyDetail>;
/** `GET /platform/accounts`. */
export type PlatformAccountListResponse = Jsonified<PlatformPage<PlatformAccountListItem>>;
/** `GET /platform/accounts/:accountId` (grava `ACCOUNT_EMAIL_VIEWED`). */
export type PlatformAccountDetailResponse = Jsonified<PlatformAccountDetail>;
/** `GET /platform/billing/orders`. */
export type PlatformOrderListResponse = Jsonified<PlatformBillingPage<PlatformOrderRow>>;
/** `GET /platform/billing/notices`. */
export type PlatformNoticeListResponse = Jsonified<PlatformBillingPage<PlatformNoticeRow>>;
/** `GET /platform/health`. */
export type PlatformHealthResponse = Jsonified<PlatformHealth>;

export type PlatformMonitorRoutes = Pick<
  PlatformMonitorService,
  | 'overview'
  | 'listCompanies'
  | 'companyDetail'
  | 'listAccounts'
  | 'accountDetail'
  | 'listOrders'
  | 'listNotices'
  | 'setCompanyStatus'
  | 'health'
>;

export interface PlatformMonitorControllerOptions {
  readonly monitor: PlatformMonitorRoutes;
}

function platformIdentity(request: FastifyRequest): PlatformIdentity {
  const identity = requestAuth(request);
  if (identity.kind !== 'platform') throw new UnauthorizedError();
  return identity;
}

/**
 * Leituras agregadas e as duas ações do admin da plataforma (spec 044, E2). Registrado **dentro** do plugin
 * `/platform` da E1 (o hook dele preenche a identidade só pelo cookie com segundo fator e confere `Origin`
 * e `X-Soprei-App` nas escritas). Toda rota: `requirePlatform()` e perfil `admin`. Finas: validam com Zod,
 * chamam o serviço e deixam o erro subir.
 */
export const platformMonitorController: FastifyPluginCallback<PlatformMonitorControllerOptions> = (
  app,
  { monitor },
  done,
) => {
  const route = { config: rateLimitProfile('admin'), onRequest: requirePlatform() };

  app.get('/overview', route, async (): Promise<PlatformOverview> => monitor.overview());

  app.get('/companies', route, async (request) => {
    const query = platformCompaniesQuerySchema.parse(request.query);
    return monitor.listCompanies(
      {
        status:
          query.status === undefined
            ? undefined
            : query.status === 'active'
              ? 'ACTIVE'
              : 'SUSPENDED',
        q: query.q === '' ? undefined : query.q,
        attention: query.attention,
      },
      { limit: query.limit, cursor: query.cursor },
    );
  });

  app.get('/companies/:companyId', route, async (request) => {
    const { companyId } = platformCompanyParamsSchema.parse(request.params);
    return monitor.companyDetail(companyId);
  });

  for (const [path, target] of [
    ['suspend', 'SUSPENDED'],
    ['reactivate', 'ACTIVE'],
  ] as const) {
    app.post(`/companies/:companyId/${path}`, route, async (request, reply) => {
      const identity = platformIdentity(request);
      const { companyId } = platformCompanyParamsSchema.parse(request.params);
      const { reason } = platformActionBodySchema.parse(request.body);
      await monitor.setCompanyStatus(identity, companyId, target, reason);
      return reply.status(204).send();
    });
  }

  app.get('/accounts', route, async (request) => {
    const query = platformAccountsQuerySchema.parse(request.query);
    return monitor.listAccounts(
      {
        status:
          query.status === undefined
            ? undefined
            : query.status === 'active'
              ? 'ACTIVE'
              : 'DISABLED',
        verified: query.verified === undefined ? undefined : query.verified === 'true',
      },
      { limit: query.limit, cursor: query.cursor },
    );
  });

  app.get('/accounts/:accountId', route, async (request) => {
    const identity = platformIdentity(request);
    const { accountId } = platformAccountParamsSchema.parse(request.params);
    return monitor.accountDetail(identity, accountId);
  });

  app.get('/billing/orders', route, async (request) => {
    const query = platformOrdersQuerySchema.parse(request.query);
    return monitor.listOrders(
      { status: query.status, kind: query.kind },
      { limit: query.limit, cursor: query.cursor },
    );
  });

  app.get('/billing/notices', route, async (request) => {
    const query = platformNoticesQuerySchema.parse(request.query);
    return monitor.listNotices({ kind: query.kind }, { limit: query.limit, cursor: query.cursor });
  });

  app.get('/health', route, async (): Promise<PlatformHealth> => monitor.health());

  done();
};
