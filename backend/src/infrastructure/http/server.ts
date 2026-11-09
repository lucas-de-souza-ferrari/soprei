import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import type { AccountService } from '../../application/auth/account.service.js';
import { accountController, accountCookie } from '../../presentation/auth/account.controller.js';
import { ForbiddenError } from '../../shared/errors/index.js';
import type { AuthService } from '../../application/auth/auth.service.js';
import type { AttendanceService } from '../../application/attendance/attendance.service.js';
import type { ChannelIntakeService } from '../../application/channel/channel-intake.service.js';
import type { ChannelConnectionService } from '../../application/channel/channel-connection.service.js';
import type { BillingService } from '../../application/billing/billing.service.js';
import type {
  EntitlementReader,
  SubscriptionHolderReader,
} from '../../application/ports/entitlement-reader.js';
import type { CheckoutService } from '../../application/billing/checkout.service.js';
import { billingController } from '../../presentation/billing/billing.controller.js';
import { infinitepayWebhookController } from '../../presentation/webhooks/infinitepay-webhook.controller.js';
import { adminEntitlementsController } from '../../presentation/admin/entitlements.controller.js';
import { registerEntitlementGate } from './entitlement-gate.js';
import type { CompanyService } from '../../application/companies/company.service.js';
import type { InvitationService } from '../../application/invitations/invitation.service.js';
import type { MembershipAdminService } from '../../application/memberships/membership-admin.service.js';
import { authController } from '../../presentation/auth/auth.controller.js';
import { adminAttendanceController } from '../../presentation/admin/attendance.controller.js';
import { adminAuditController } from '../../presentation/admin/audit.controller.js';
import {
  adminChannelController,
  type ChannelSetupInfo,
} from '../../presentation/admin/channel.controller.js';
import { adminCompaniesController } from '../../presentation/admin/companies.controller.js';
import { adminInvitationsController } from '../../presentation/admin/invitations.controller.js';
import { adminMembershipsController } from '../../presentation/admin/memberships.controller.js';
import {
  healthController,
  type ReadinessChecks,
} from '../../presentation/system/health.controller.js';
import { adminKnowledgeController } from '../../presentation/admin/knowledge.controller.js';
import { adminOnboardingController } from '../../presentation/admin/onboarding.controller.js';
import { adminPersonaController } from '../../presentation/admin/persona.controller.js';
import { adminInventoryController } from '../../presentation/admin/inventory.controller.js';
import {
  adminScheduleController,
  type AdminScheduleControllerOptions,
} from '../../presentation/admin/schedule.controller.js';
import type { InventoryService } from '../../application/inventory/inventory.service.js';
import type { SampleDataService } from '../../application/knowledge/sample.service.js';
import type { OnboardingService } from '../../application/onboarding/onboarding.service.js';
import type { KnowledgeService } from '../../application/knowledge/knowledge.service.js';
import { metricsController } from '../../presentation/system/metrics.controller.js';
import { whatsappWebhookController } from '../../presentation/webhooks/whatsapp-webhook.controller.js';
import type { TrustProxySetting } from '../config/trust-proxy.js';
import type { Metrics } from '../metrics/index.js';
import { errorHandler, notFoundHandler } from './error-handler.js';
import { generateRequestId, registerObservability } from './observability/observability.js';
import { type RateLimitParams, registerRateLimit } from './rate-limit/rate-limit.js';

export interface AdminRoutesParams {
  readonly companies: CompanyService;
  /** Sem isto as rotas de mensagens e conversas (spec 010) não são registradas. */
  readonly attendance?: AttendanceService;
  /**
   * Conexão do canal WhatsApp da empresa (spec 015): `GET`, `PUT` e `DELETE` em
   * `/admin/companies/:companyId/channel`. Só existe com `WHATSAPP_ENABLED=true` (sem isto, 404).
   */
  readonly channel?: Pick<
    ChannelConnectionService,
    'getState' | 'connect' | 'disconnect' | 'embeddedSignup'
  >;
  /** Assistente de primeiros passos (spec 030); sem isto as rotas `.../onboarding` não existem. */
  readonly onboarding?: Pick<OnboardingService, 'get' | 'setDismissed'>;
  /** Documentos da base de conhecimento (spec 026); sem isto as rotas `.../knowledge/*` não existem. */
  readonly knowledge?: Pick<KnowledgeService, 'list' | 'create' | 'delete'>;
  /** Dados de exemplo (spec 026, E3); sem isto as rotas `.../knowledge/sample` não existem. */
  readonly sample?: Pick<SampleDataService, 'load' | 'remove'>;
  /** Estoque da empresa (spec 026, E2); sem isto as rotas `.../inventory/*` não existem. */
  readonly inventory?: Pick<
    InventoryService,
    'list' | 'create' | 'update' | 'adjust' | 'movements' | 'importRows'
  >;
  /** Agenda da empresa (spec 027); sem isto as rotas `.../schedule/*` não existem. */
  readonly schedule?: AdminScheduleControllerOptions['schedule'];
  /** Exemplo da agenda (spec 027, E4); sem isto as rotas `.../schedule/sample` não existem. */
  readonly scheduleSample?: AdminScheduleControllerOptions['sample'];
  /** Valores públicos do Embedded Signup para o site (spec 023); sem isto `.../channel/setup` não existe. */
  readonly channelSetup?: ChannelSetupInfo;
}

/** Canal WhatsApp (spec 011): sem isto as rotas `/webhooks/whatsapp` NÃO existem (404). */
export interface WhatsappRoutesParams {
  /** `WHATSAPP_APP_SECRET`: só valida a assinatura. */
  readonly appSecret: string;
  /** `WHATSAPP_VERIFY_TOKEN`: só o handshake de verificação. */
  readonly verifyToken: string;
  readonly intake: Pick<ChannelIntakeService, 'accept'>;
}

/**
 * Cobrança (spec 031). Opt-in: sem isto (`BILLING_ENABLED=false`) nada é limitado, as rotas de cobrança não
 * existem (404) e as rotas de tenant têm exatamente o custo de antes.
 */
export interface BillingRoutesParams {
  readonly service: Pick<BillingService, 'overview'>;
  readonly entitlements: Pick<EntitlementReader, 'forCompany'> & Partial<SubscriptionHolderReader>;
  /** Host do link de pagamento (INFINITEPAY_CHECKOUT_HOST): o site só o abre se for este (defesa em profundidade). */
  readonly checkoutHost?: string | undefined;
  /** Checkout da InfinitePay (E3, CHECKOUT_ENABLED): pedido, "Já paguei" e webhook. Sem isto essas rotas não existem. */
  readonly checkout?: Pick<
    CheckoutService,
    | 'createOrder'
    | 'checkOrder'
    | 'acceptWebhook'
    | 'quote'
    | 'upgrade'
    | 'scheduleChange'
    | 'undoPendingChange'
    | 'cancel'
    | 'reactivate'
    | 'changeState'
  >;
}

export interface BuildServerParams {
  /** Cobrança por planos (spec 031); precisa de `accounts` para as rotas da conta. */
  readonly billing?: BillingRoutesParams;
  readonly accounts?: {
    service: AccountService;
    origin: string;
    secure: boolean;
    /** Convites por e-mail (spec 025): só existem com contas globais ligadas (sem isto, 404). */
    invitations?: InvitationService;
  };
  readonly logger: FastifyBaseLogger;
  readonly readiness: ReadinessChecks;
  /**
   * Autenticação (spec 007): registra `/auth/*` e verifica os access tokens das rotas `/admin`.
   * Obrigatória quando `admin` é passado (rota protegida sem autenticação nunca sobe).
   */
  readonly auth?: AuthService;
  /**
   * Gestão de usuários da empresa, auditoria e troca da própria senha (spec 008): registra
   * `POST /auth/password` e, com `admin`, as rotas `/admin/companies/:companyId/memberships` e
   * `.../audit-events`. Exige `auth`. Sem isto essas rotas não existem.
   */
  readonly membershipAdmin?: MembershipAdminService;
  /** Sem isto as rotas /admin não são registradas (ex.: testes que não precisam delas). */
  readonly admin?: AdminRoutesParams;
  /** Canal WhatsApp (spec 011). Opt-in: sem isto (`WHATSAPP_ENABLED=false`) as rotas não existem. */
  readonly whatsapp?: WhatsappRoutesParams;
  /** Métricas do processo. Sem isto não há métricas HTTP nem `GET /metrics`. */
  readonly metrics?: Metrics;
  /**
   * `METRICS_TOKEN`. `GET /metrics` só existe quando `metrics` e este token (já validado
   * na config, mínimo 32 caracteres) estão presentes; sem ele a rota responde 404.
   */
  readonly metricsToken?: string | undefined;
  /**
   * Rate limiting (spec 005). Sem isto o plugin NÃO é registrado e nada é limitado (testes que
   * não tratam de limite). Em produção o boot sempre passa (`RATE_LIMIT_ENABLED`).
   */
  readonly rateLimit?: RateLimitParams;
  /**
   * `TRUST_PROXY` (spec 005): de onde o Fastify tira `request.ip`. `false` (padrão) ignora
   * `X-Forwarded-For`; ver `trust-proxy.ts` para os demais valores.
   */
  readonly trustProxy?: TrustProxySetting;
}

/** O Fastify quer `string[]` mutável; a config entrega `readonly string[]`. */
function fastifyTrustProxy(setting: TrustProxySetting): boolean | string[] {
  return typeof setting === 'object' ? [...setting] : setting;
}

/** Monta o servidor sem escutar em porta, para que os testes usem `inject`. */
export function buildServer({
  logger,
  readiness,
  auth,
  membershipAdmin,
  admin,
  whatsapp,
  metrics,
  metricsToken,
  rateLimit,
  trustProxy = false,
  accounts,
  billing,
}: BuildServerParams): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    // `request.ip` (chave do rate limit) vem do socket, ou do X-Forwarded-For só se confiado.
    trustProxy: fastifyTrustProxy(trustProxy),
    // `x-request-id` válido é reaproveitado; senão UUID. `requestIdHeader: false` deixa a
    // decisão toda para `genReqId`.
    genReqId: generateRequestId,
    requestIdHeader: false,
    // Log de requisição próprio (observability.ts): um log ao fim, com o padrão da rota, e o
    // id da requisição no campo `requestId`. O Fastify 5.12 deprecou `disableRequestLogging` e
    // `requestIdLogLabel` no topo das opções em favor do `LogController`.
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
  });

  // Preenchido pelo hook `authenticate` (spec 007); `null` nas rotas públicas.
  app.decorateRequest('auth', null);

  registerObservability(app, { metrics });
  // Depois da observabilidade (o 429 entra no log e nas métricas HTTP) e antes das rotas (o
  // plugin liga o hook em cada rota registrada depois dele).
  if (rateLimit !== undefined) registerRateLimit(app, rateLimit, metrics);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  if (accounts !== undefined) {
    app.addHook('onRequest', async (request, reply) => {
      const path = request.routeOptions.url ?? '';
      if (path.startsWith('/admin/') || path === '/auth/me')
        void reply.header('cache-control', 'no-store');
      if (
        (path.endsWith('/memberships') && request.method === 'POST') ||
        path.endsWith('/memberships/:membershipId/password') ||
        path === '/auth/password'
      ) {
        throw new ForbiddenError('Gestão de senha e criação de conta são globais');
      }
      if (
        request.headers.authorization === undefined &&
        request.headers.cookie !== undefined &&
        (path.startsWith('/admin/') || path === '/auth/me')
      ) {
        request.auth = await accounts.service.tenantIdentity(accountCookie(request.headers.cookie));
      }
      if (
        request.auth !== null &&
        !['GET', 'HEAD'].includes(request.method) &&
        (request.headers.origin !== accounts.origin || request.headers['x-soprei-app'] !== 'web')
      ) {
        throw new ForbiddenError('Origem inválida');
      }
    });
    // Envios de confirmação em segundo plano não se perdem em silêncio no desligamento.
    app.addHook('onClose', async () => {
      await accounts.service.drain();
      await accounts.invitations?.drain();
    });
    void app.register(accountController, {
      service: accounts.service,
      origin: accounts.origin,
      secure: accounts.secure,
      ...(accounts.invitations === undefined ? {} : { invitations: accounts.invitations }),
      ...(auth === undefined ? {} : { legacyAuth: auth }),
    });
  }

  // Política de assinatura das escritas de tenant (spec 031): só com a cobrança ligada.
  if (billing !== undefined) registerEntitlementGate(app, billing.entitlements);
  if (billing !== undefined && accounts !== undefined) {
    void app.register(billingController, {
      service: billing.service,
      accounts: accounts.service,
      origin: accounts.origin,
      checkout: billing.checkout,
      checkoutHost: billing.checkoutHost,
    });
  }
  // Webhook público do checkout (spec 031, E3): corpo não confiado, só grava a referência e confirma por consulta.
  if (billing?.checkout !== undefined) {
    void app.register(infinitepayWebhookController, { checkout: billing.checkout, metrics });
  }

  void app.register(healthController, { readiness });
  if (metrics !== undefined && metricsToken !== undefined && metricsToken !== '') {
    void app.register(metricsController, { token: metricsToken, source: metrics });
  }
  if (auth !== undefined) {
    void app.register(authController, {
      prefix: '/auth',
      auth,
      metrics,
      browserAccounts: accounts !== undefined,
      ...(membershipAdmin === undefined ? {} : { membershipAdmin }),
    });
  }
  if (admin !== undefined) {
    // Rota /admin sem verificação de token nunca sobe: falha o boot, não vira rota aberta.
    if (auth === undefined) {
      throw new Error('as rotas /admin exigem o serviço de autenticação (auth)');
    }
    void app.register(adminCompaniesController, {
      prefix: '/admin/companies',
      auth,
      metrics,
      companies: admin.companies,
    });
    if (membershipAdmin !== undefined) {
      void app.register(adminMembershipsController, {
        prefix: '/admin/companies',
        auth,
        metrics,
        memberships: membershipAdmin,
      });
      void app.register(adminAuditController, {
        prefix: '/admin/companies',
        auth,
        metrics,
        memberships: membershipAdmin,
      });
    }
    if (accounts?.invitations !== undefined) {
      void app.register(adminInvitationsController, {
        prefix: '/admin/companies',
        auth,
        metrics,
        invitations: accounts.invitations,
      });
    }
    if (admin.channel !== undefined) {
      void app.register(adminChannelController, {
        prefix: '/admin/companies',
        auth,
        metrics,
        channel: admin.channel,
        setup: admin.channelSetup,
      });
    }
    void app.register(adminEntitlementsController, {
      prefix: '/admin/companies',
      auth,
      metrics,
      entitlements: billing?.entitlements,
    });
    void app.register(adminPersonaController, {
      prefix: '/admin/companies',
      auth,
      metrics,
      companies: admin.companies,
    });
    if (admin.onboarding !== undefined) {
      void app.register(adminOnboardingController, {
        prefix: '/admin/companies',
        auth,
        metrics,
        onboarding: admin.onboarding,
      });
    }
    if (admin.knowledge !== undefined) {
      void app.register(adminKnowledgeController, {
        prefix: '/admin/companies',
        auth,
        metrics,
        knowledge: admin.knowledge,
        sample: admin.sample,
        entitlements: billing?.entitlements,
      });
    }
    if (admin.inventory !== undefined) {
      void app.register(adminInventoryController, {
        prefix: '/admin/companies',
        auth,
        metrics,
        inventory: admin.inventory,
      });
    }
    if (admin.schedule !== undefined) {
      void app.register(adminScheduleController, {
        prefix: '/admin/companies',
        auth,
        metrics,
        schedule: admin.schedule,
        sample: admin.scheduleSample,
      });
    }
    if (admin.attendance !== undefined) {
      void app.register(adminAttendanceController, {
        prefix: '/admin/companies',
        auth,
        metrics,
        attendance: admin.attendance,
      });
    }
  }

  if (whatsapp !== undefined) {
    void app.register(whatsappWebhookController, {
      appSecret: whatsapp.appSecret,
      verifyToken: whatsapp.verifyToken,
      intake: whatsapp.intake,
      ...(metrics === undefined ? {} : { metrics }),
    });
  }

  return app;
}
